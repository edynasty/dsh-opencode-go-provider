/**
 * The production OpenCode Go adapter: one route, three wire protocols.
 *
 * Each operation captures an immutable snapshot — the resolved config, the
 * per-operation credential and the catalog's pi-ai `Models` collection — so a
 * config or catalog change reaches the next request while an in-flight request
 * keeps what it started with. The wire protocol is chosen strictly by the
 * catalog entry's `api`/`baseUrl`; no model-id or provider-name heuristic ever
 * selects a transport, and a failed stream never falls through to another one.
 *
 * Credentials stay outside the collection: the harness resolves the route's
 * key through its own seam and hands it over as the request's `apiKey` option,
 * which pi-ai treats as the highest-priority auth override.
 */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { LlmAdapter, ReasoningEffortId, attributionHeaders, contentHasImage } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { createModels } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Config, ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { DISPLAY_NAME, PROVIDER_ROUTE } from "./contract.ts";
import { toPiContext } from "./context.ts";
import { ABORTED, NO_ADAPTER, TIMEOUT, UNKNOWN_MODEL, UNSUPPORTED_CONTENT, UNSUPPORTED_REASONING_EFFORT, llmError } from "./errors.ts";
import { buildProvider, toPiModel } from "./provider.ts";
import { assertSupportedOptions } from "./options.ts";
import { toStreamChunks } from "./stream.ts";
import type { CatalogModel, Protocol } from "./types.ts";

/** Watchdog code stamped onto the idle-timeout abort reason. */
const IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

/** Dependencies the service wires in; the catalog thunk lets Task 6 hot-swap snapshots. */
export interface OpenCodeGoAdapterOptions {
  /** Live config source; re-read on every operation so settings hot-apply. */
  readonly currentConfig: () => Config;
  /** Per-operation credential resolver, gating every stream before network. */
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  /** Embedded catalog source; advisory and credential-free. */
  readonly catalog: () => readonly CatalogModel[];
  /** Optional durable attachment service for image input. */
  readonly resolveAttachments?: () => AttachmentStore | undefined;
}

/** One operation's immutable catalog+collection pairing. */
interface Snapshot {
  readonly catalog: readonly CatalogModel[];
  readonly index: ReadonlyMap<string, CatalogModel>;
  readonly models: MutableModels;
}

/** Selectable reasoning levels for one model, or nothing for a non-reasoning model. */
function reasoningInfo(model: Model<Protocol>): Pick<LlmResolvedModelInfo, "reasoning"> | Record<string, never> {
  if (!model.reasoning) return {};
  return {
    reasoning: {
      efforts: getSupportedThinkingLevels(model).map((level) => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
    },
  };
}

/**
 * Validate an explicit reasoning effort against the model's supported levels
 * without invoking pi-ai's clamping: an unsupported level fails before network.
 */
function resolveReasoningLevel(model: Model<Protocol>, effort: ReasoningEffortIdType | undefined): ThinkingLevel | undefined {
  if (effort === undefined) return undefined;
  const level = getSupportedThinkingLevels(model).find((candidate) => String(candidate) === String(effort));
  if (level === undefined) {
    throw llmError(
      `opencode-go provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
      UNSUPPORTED_REASONING_EFFORT,
    );
  }
  return level === "off" ? undefined : level;
}

/**
 * OpenCode Go single-route adapter. Each operation reads the current catalog
 * and config, so a change reaches the next request without a restart.
 */
export class OpenCodeGoAdapter extends LlmAdapter {
  private snapshot: Snapshot | undefined;

  constructor(private readonly deps: OpenCodeGoAdapterOptions) {
    super();
  }

  /** The snapshot for the current catalog; memoized by collection identity. */
  private current(): Snapshot {
    const catalog = this.deps.catalog();
    if (this.snapshot?.catalog === catalog) return this.snapshot;
    const snapshot: Snapshot = {
      catalog,
      index: new Map(catalog.map((model) => [model.id, model])),
      models: createModels(),
    };
    snapshot.models.setProvider(buildProvider(catalog));
    this.snapshot = snapshot;
    return snapshot;
  }

  /** Refuse a provider route this adapter does not own. */
  private profileOf(provider: string): void {
    if (provider !== PROVIDER_ROUTE) {
      throw llmError(`opencode-go adapter does not own provider "${provider}"`, NO_ADAPTER);
    }
  }

  /** The catalog entry for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: Snapshot, provider: string, model: string): CatalogModel {
    this.profileOf(provider);
    const entry = snapshot.index.get(model);
    if (entry === undefined) {
      throw llmError(`opencode-go provider has no configured model "${model}"`, UNKNOWN_MODEL);
    }
    return entry;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const snapshot = this.current();
    this.profileOf(provider);
    return snapshot.catalog.map((model): LlmModelInfo => {
      const modalities = toPiModel(model).input;
      return {
        provider,
        id: model.id,
        name: model.name,
        ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
      };
    });
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const snapshot = this.current();
    const entry = this.modelOf(snapshot, provider, model);
    const piModel = toPiModel(entry);
    const modalities = piModel.input;
    return {
      provider,
      id: entry.id,
      name: entry.name,
      ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
      context: { contextWindow: entry.contextWindow },
      ...reasoningInfo(piModel),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The snapshot is captured at invocation, before any await: a catalog
    // swap while credentials resolve must not change this request's
    // model/provider/baseUrl identity.
    const snapshot = this.current();
    // Credential gate: the per-operation config and key resolution happen
    // before any callback or network; a missing or invalid key throws.
    const resolved: ResolvedConfig = resolveConfig(this.deps.currentConfig());
    const key = await this.deps.resolveKey(resolved.apiKeyEnv);
    const entry = this.modelOf(snapshot, options.provider, options.model);
    const piModel = toPiModel(entry);
    assertSupportedOptions(options);
    const reasoning = resolveReasoningLevel(piModel, options.reasoningEffort);
    const consumer = new AbortController();
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const timeoutMs = resolved.timeoutMs;
    const watchdog = idleWatchdog(upstream, timeoutMs, IDLE_TIMEOUT_CODE);
    try {
      const containsImage = options.messages.some((message) => contentHasImage(message.content));
      if (containsImage && !piModel.input.includes("image")) {
        throw llmError(`opencode-go model "${piModel.id}" does not support image input`, UNSUPPORTED_CONTENT);
      }
      const attachments = containsImage ? this.deps.resolveAttachments?.() : undefined;
      if (containsImage && attachments === undefined) {
        throw llmError("opencode-go image input requires the durable attachment service", UNSUPPORTED_CONTENT);
      }
      const context = await toPiContext(options, attachments);
      const iterator = toStreamChunks(
        snapshot.models.streamSimple(piModel, context, {
          apiKey: key,
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
          signal: watchdog.signal,
          timeoutMs,
          maxRetries: 0,
          headers: attributionHeaders(),
        }),
        piModel.contextWindow,
      )[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const result = await watchdog.next(iterator);
          const timeout = timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE);
          if (timeout !== undefined) throw timeout;
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!exhausted) {
          consumer.abort("opencode-go stream consumer stopped");
          try {
            await iterator.return(undefined);
          } catch {
            // the SDK teardown failure is already surfaced as the terminal outcome
          }
        }
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE) !== undefined) {
        throw llmError(`opencode-go stream idle timeout after ${timeoutMs}ms`, TIMEOUT, { cause: error });
      }
      if (options.signal?.aborted) {
        throw llmError("opencode-go request aborted by caller", ABORTED, { cause: error });
      }
      throw error;
    } finally {
      consumer.abort("opencode-go stream consumer stopped");
    }
  }
}
