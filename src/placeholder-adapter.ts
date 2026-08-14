/**
 * Task 4 placeholder adapter for the OpenCode Go provider route.
 *
 * It can list and resolve the embedded catalog (advisory, no credential
 * needed) but performs no generation or network. The stream entry credential-
 * gates first — missing and invalid keys fail before any callback or fetch —
 * and then refuses with a stable not-yet-implemented code, so Task 5 can
 * replace the body without changing the route identity or the gate.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { Config, ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { PROVIDER_ROUTE } from "./contract.ts";
import type { CatalogModel, ModalityLiteral } from "./types.ts";

/** Stable machine code for Task 5 functionality being requested on this contract. */
export const NOT_IMPLEMENTED_CODE = "NOT_IMPLEMENTED";

/** Display name served by the provider directory and selectors. */
export const DISPLAY_NAME = "OpenCode Go";

/** Dependencies the service wires in; the catalog thunk lets Task 6 hot-swap snapshots. */
export interface PlaceholderAdapterDeps {
  /** Live config source; re-read on every operation so settings hot-apply. */
  readonly currentConfig: () => Config;
  /** Per-operation credential resolver, gating every stream before network. */
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  /** Embedded catalog source; advisory and credential-free. */
  readonly catalog: () => readonly CatalogModel[];
}

/** Project DSH-known modalities into the adapter vocabulary (text/image only). */
function toInputModalities(input: readonly ModalityLiteral[]): readonly ModelModality[] | undefined {
  const modalities: ModelModality[] = [];
  for (const literal of input) {
    if (literal === "text" || literal === "image") modalities.push(literal);
  }
  return modalities.length === 0 ? undefined : modalities;
}

/** Map one embedded catalog entry into advisory DSH model metadata. */
function toModelInfo(model: CatalogModel): LlmModelInfo {
  const inputModalities = model.input === undefined ? undefined : toInputModalities(model.input);
  return {
    provider: PROVIDER_ROUTE,
    id: model.id,
    name: model.name,
    ...(inputModalities === undefined ? {} : { inputModalities }),
  };
}

/** Minimal Task-4 adapter: catalog browsing plus a credential-gated stub stream. */
export class PlaceholderAdapter extends LlmAdapter {
  constructor(private readonly deps: PlaceholderAdapterDeps) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME };
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider !== PROVIDER_ROUTE) return Promise.resolve([]);
    return Promise.resolve(this.deps.catalog().map(toModelInfo));
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== PROVIDER_ROUTE) {
      return Promise.resolve({ provider, id: model, name: model });
    }
    const found = this.deps.catalog().find((entry) => entry.id === model);
    if (found === undefined) return Promise.resolve({ provider, id: model, name: model });
    const inputModalities = found.input === undefined ? undefined : toInputModalities(found.input);
    return Promise.resolve({
      provider: PROVIDER_ROUTE,
      id: found.id,
      name: found.name,
      ...(inputModalities === undefined ? {} : { inputModalities }),
      ...(found.contextWindow > 0
        ? { context: { contextWindow: found.contextWindow } }
        : {}),
    });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Credential gate first: the per-operation snapshot and key resolution
    // happen before any callback or network; a missing or invalid key throws.
    const snapshot: ResolvedConfig = resolveConfig(this.deps.currentConfig());
    void (await this.deps.resolveKey(snapshot.apiKeyEnv));
    throw new LlmError(
      `dsh-opencode-go-provider: generation for provider "${options.provider}" is not implemented`
        + " in this contract; the wire adapter ships in a later task",
      NOT_IMPLEMENTED_CODE,
    );
  }
}
