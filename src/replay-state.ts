/**
 * Durable pi-ai replay state: projection, validation and safe narrowing.
 *
 * Harness content remains the durable source for text, reasoning and tool
 * calls; this module stores only the provider-native metadata needed to
 * reconstruct a pi-ai assistant message on a later request. The projection is
 * validated structurally on the way back in, and every field is narrowed
 * without casts before it is handed to pi-ai.
 */
import type { Api, AssistantMessage } from "@earendil-works/pi-ai";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { INVALID_REPLAY_STATE } from "./errors.ts";
import { isRecord } from "./guards.ts";

/** One durable block's provider-native replay facts. */
export type OpenCodeGoReplayBlock =
  | { readonly type: "text"; readonly textSignature?: string }
  | {
      readonly type: "reasoning";
      readonly thinkingSignature?: string;
      readonly redacted?: boolean;
    }
  | { readonly type: "tool-call"; readonly thoughtSignature?: string };

/** Versioned adapter-private projection required to replay a pi-ai response. */
export interface OpenCodeGoReplayState {
  readonly kind: "opencode-go";
  readonly version: 1;
  readonly api: Api;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly stopReason: AssistantMessage["stopReason"];
  readonly blocks: readonly OpenCodeGoReplayBlock[];
}

/**
 * Parse durable tool-call argument JSON. Malformed JSON or a value that is not
 * a plain object (array, null, primitive) is a broken durable history and
 * fails with `INVALID_REPLAY_STATE` — never silently replaced by {}.
 */
export function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidReplay("tool-call arguments are not valid JSON");
  }
  if (!isRecord(parsed)) {
    return invalidReplay("tool-call arguments must be a JSON object");
  }
  return parsed;
}

/** The zero usage value required by historical pi-ai messages. */
export function emptyPiUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Project a successful pi-ai response into the minimal durable replay state.
 * @param message - completed native pi-ai assistant response.
 * @returns the versioned lossless-JSON replay projection.
 */
export function toReplayState(message: AssistantMessage): OpenCodeGoReplayState {
  return {
    kind: "opencode-go",
    version: 1,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    stopReason: message.stopReason,
    blocks: message.content.map((block) => {
      if (block.type === "text") {
        return {
          type: "text",
          ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
        };
      }
      if (block.type === "thinking") {
        return {
          type: "reasoning",
          ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
          ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        };
      }
      return {
        type: "tool-call",
        ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
      };
    }),
  };
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid opencode-go replay state: ${message}`, INVALID_REPLAY_STATE);
}

/** Narrow one optional string field, rejecting any non-string value. */
function optionalString(entry: Record<string, unknown>, key: string, index: number): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalidReplay(`block ${index} ${key} must be a string`);
  return value;
}

/** Narrow one optional boolean field, rejecting any non-boolean value. */
function optionalBoolean(entry: Record<string, unknown>, key: string, index: number): boolean | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return invalidReplay(`block ${index} ${key} must be boolean`);
  return value;
}

/** Wire protocols this bundle's replay projection may name. */
const SUPPORTED_REPLAY_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/**
 * Validate the adapter-private state before it reaches pi-ai. Every field is
 * narrowed by inspection; no value is trusted as the declared type, and a
 * replay naming a wire protocol this bundle cannot serve is refused.
 */
export function readReplayState(value: unknown): OpenCodeGoReplayState {
  // Since DSH rc.7, the finish-chunk/message-source replay state is a
  // ReplayEnvelope ({ response: <adapter payload> }); unwrap the payload
  // before validating. Legacy rc.6-era raw states pass through unchanged.
  if (isRecord(value) && value["kind"] !== "opencode-go" && "response" in value) {
    value = value["response"];
  }
  if (!isRecord(value)) return invalidReplay("expected an object");
  if (value["kind"] !== "opencode-go") return invalidReplay("unknown state kind");
  if (value["version"] !== 1) return invalidReplay(`unsupported version ${String(value["version"])}`);
  const api = value["api"];
  const supportedApi = SUPPORTED_REPLAY_APIS.find((candidate) => candidate === api);
  if (supportedApi === undefined) {
    return invalidReplay("unsupported api; only the opencode-go transport protocols can be replayed");
  }
  const provider = value["provider"];
  if (typeof provider !== "string" || provider.length === 0) {
    return invalidReplay("provider must be a non-empty string");
  }
  const model = value["model"];
  if (typeof model !== "string" || model.length === 0) return invalidReplay("model must be a non-empty string");
  const stopReasons = ["stop", "length", "toolUse", "error", "aborted"] as const;
  const stopReason = stopReasons.find((reason) => reason === value["stopReason"]);
  if (stopReason === undefined) return invalidReplay("unknown stopReason");
  const responseModel = value["responseModel"];
  if (responseModel !== undefined && typeof responseModel !== "string") {
    return invalidReplay("responseModel must be a string");
  }
  const responseId = value["responseId"];
  if (responseId !== undefined && typeof responseId !== "string") {
    return invalidReplay("responseId must be a string");
  }
  const rawBlocks = value["blocks"];
  if (!Array.isArray(rawBlocks)) return invalidReplay("blocks must be an array");
  const blocks: OpenCodeGoReplayBlock[] = [];
  for (const [index, entry] of rawBlocks.entries()) {
    if (!isRecord(entry)) return invalidReplay(`block ${index} must be an object`);
    const kinds = ["text", "reasoning", "tool-call"] as const;
    const kind = kinds.find((candidate) => candidate === entry["type"]);
    if (kind === undefined) return invalidReplay(`block ${index} has an unknown type`);
    const textSignature = optionalString(entry, "textSignature", index);
    const thinkingSignature = optionalString(entry, "thinkingSignature", index);
    const thoughtSignature = optionalString(entry, "thoughtSignature", index);
    const redacted = optionalBoolean(entry, "redacted", index);
    if (kind === "text") {
      blocks.push({
        type: "text",
        ...(textSignature === undefined ? {} : { textSignature }),
      });
    } else if (kind === "reasoning") {
      blocks.push({
        type: "reasoning",
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(redacted === undefined ? {} : { redacted }),
      });
    } else {
      blocks.push({
        type: "tool-call",
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      });
    }
  }
  return {
    kind: "opencode-go",
    version: 1,
    api: supportedApi,
    provider,
    model,
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(responseId === undefined ? {} : { responseId }),
    stopReason,
    blocks,
  };
}
