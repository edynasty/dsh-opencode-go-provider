/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation, so tool-call deltas are accumulated verbatim and
 * published exactly as the wire delivered them — whitespace, numeric spelling,
 * unicode escapes and key order included. pi-ai reports failures as terminal
 * stream events, which this module maps into error/aborted finish chunks with
 * stable codes.
 */
import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, LlmError } from "@deepseek-ai/dsh-llm";
import type { FinishReason, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from "@earendil-works/pi-ai";
import { ABORTED, INVALID_REQUEST, STREAM_CLOSED, classifyProviderFailure, llmError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { toReplayState } from "./replay-state.ts";

/**
 * Map pi-ai usage into harness counts. Cache and reasoning fields appear only
 * when present and non-zero; absent fields stay absent (deterministic).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns the harness token accounting.
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage.reasoning !== undefined && usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}),
  };
}

/**
 * Map a terminal pi-ai event to the harness finish reason. Recognized error
 * text, `stop` usage above `contextWindow`, and zero-output `length` usage
 * that fills the window map to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no
 * content blocks maps to an `EMPTY_RESPONSE` error.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason.
 */
export function mapFinishReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piOverflow = isContextOverflow(message, contextWindow);
  const harnessOverflow =
    message.stopReason === "error"
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage);
  if (piOverflow || harnessOverflow) {
    return {
      kind: "error",
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    };
  }
  switch (message.stopReason) {
    case "stop":
      if (message.content.length === 0) {
        return {
          kind: "error",
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        };
      }
      return { kind: "stop" };
    case "length":
      return { kind: "max-tokens" };
    case "toolUse":
      return { kind: "tool-calls" };
    case "aborted":
      return {
        kind: "aborted",
        failure: { message: message.errorMessage ?? "opencode-go stream aborted", code: ABORTED },
      };
    case "error": {
      const text = message.errorMessage ?? "opencode-go stream error";
      return { kind: "error", failure: { message: text, code: classifyProviderFailure(text) } };
    }
  }
}

/** True when `text` parses to a plain JSON object (not an array or primitive). */
function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { readonly id: string; readonly name: string }>();
  const rawArguments = new Map<number, string>();
  for await (const event of events) {
    switch (event.type) {
      case "start":
        break;
      case "text_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "text" };
        break;
      case "text_delta":
        yield { type: "text-delta", index: event.contentIndex, text: event.delta };
        break;
      case "text_end":
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: { type: "text", text: event.content },
        };
        break;
      case "thinking_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
        break;
      case "thinking_delta":
        yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
        break;
      case "thinking_end":
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: { type: "reasoning", text: event.content },
        };
        break;
      case "toolcall_start": {
        const partial = event.partial.content[event.contentIndex];
        const id = partial?.type === "toolCall" ? partial.id : "";
        const name = partial?.type === "toolCall" ? partial.name : "";
        toolIds.set(event.contentIndex, { id, name });
        rawArguments.set(event.contentIndex, "");
        yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
        break;
      }
      case "toolcall_delta": {
        const known = toolIds.get(event.contentIndex);
        rawArguments.set(event.contentIndex, (rawArguments.get(event.contentIndex) ?? "") + event.delta);
        yield {
          type: "tool-call-delta",
          index: event.contentIndex,
          id: CallId(known?.id ?? ""),
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        };
        break;
      }
      case "toolcall_end": {
        const raw = rawArguments.get(event.contentIndex);
        rawArguments.delete(event.contentIndex);
        const call = event.toolCall;
        let argumentsText: string;
        if (raw !== undefined && raw.length > 0) {
          // The wire delivered argument deltas: publish them verbatim, only
          // after proving they form a JSON object — never a re-serialization.
          if (!isJsonObject(raw)) {
            throw llmError(
              `opencode-go tool call "${call.name}" produced arguments that are not a JSON object`,
              INVALID_REQUEST,
            );
          }
          argumentsText = raw;
        } else {
          // No deltas were exposed (e.g. a tool_use block carrying its input
          // up front): fall back to the assembled end object, deterministically
          // serialized. This is not byte-lossless — the SDK did not expose bytes.
          if (!isRecord(call.arguments)) {
            throw llmError(
              `opencode-go tool call "${call.name}" produced arguments that are not a JSON object`,
              INVALID_REQUEST,
            );
          }
          argumentsText = JSON.stringify(call.arguments);
        }
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: {
            type: "tool-call",
            id: CallId(call.id),
            name: call.name,
            arguments: argumentsText,
          },
        };
        break;
      }
      case "done":
        yield { type: "usage", usage: mapUsage(event.message.usage) };
        yield {
          type: "finish",
          reason: mapFinishReason(event.message, contextWindow),
          replayState: { response: toReplayState(event.message) },
        };
        return;
      case "error":
        yield { type: "usage", usage: mapUsage(event.error.usage) };
        yield { type: "finish", reason: mapFinishReason(event.error, contextWindow) };
        return;
    }
  }
  throw new LlmError("pi-ai event stream ended without done/error", STREAM_CLOSED);
}
