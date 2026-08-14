/**
 * Assistant-history reconstruction for pi-ai requests.
 *
 * Harness content is the durable source; replay metadata recombines it into a
 * provider-native assistant message so reasoning/thinking and tool continuation
 * survive a later request in the SDK message format each transport expects.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { Message } from "@deepseek-ai/dsh-llm";
import { INVALID_REPLAY_STATE } from "./errors.ts";
import { emptyPiUsage, parseArguments, readReplayState } from "./replay-state.ts";

function invalidReplay(message: string): never {
  throw new LlmError(`invalid opencode-go replay state: ${message}`, INVALID_REPLAY_STATE);
}

/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === "model" ? message.source : undefined;
  const content: AssistantMessage["content"] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "reasoning") {
      content.push({ type: "thinking", thinking: block.text });
    } else if (block.type === "tool-call") {
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      });
    } else if (block.type === "image") {
      throw new LlmError(
        "opencode-go chat history cannot represent structured assistant image output",
        "UNSUPPORTED_CONTENT",
      );
    }
  }
  return {
    role: "assistant",
    content,
    api: "dsh-foreign",
    provider: source?.provider ?? "dsh-foreign",
    model: source?.model ?? "dsh-foreign",
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
  };
}

/** Recombine durable Harness content with validated replay metadata. */
function replayedAssistant(message: Message, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState);
  const source = message.source.kind === "model" ? message.source : undefined;
  if (state.provider !== source?.provider) return invalidReplay("provider does not match assistant source");
  if (state.model !== source.model) return invalidReplay("model does not match assistant source");
  if (state.blocks.length !== message.content.length) {
    return invalidReplay("block count does not match assistant content");
  }
  const content = message.content.map((block, index): AssistantMessage["content"][number] => {
    const replay = state.blocks[index];
    if (replay === undefined || replay.type !== block.type) {
      return invalidReplay(`block ${index} does not match assistant content`);
    }
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(replay.type === "text" && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
      };
    }
    if (block.type === "reasoning") {
      return {
        type: "thinking",
        thinking: block.text,
        ...(replay.type === "reasoning" && replay.thinkingSignature !== undefined
          ? { thinkingSignature: replay.thinkingSignature }
          : {}),
        ...(replay.type === "reasoning" && replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      };
    }
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      ...(replay.type === "tool-call" && replay.thoughtSignature !== undefined
        ? { thoughtSignature: replay.thoughtSignature }
        : {}),
    };
  });
  return {
    role: "assistant",
    content,
    api: state.api,
    provider: state.provider,
    model: state.model,
    ...(state.responseModel === undefined ? {} : { responseModel: state.responseModel }),
    ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
    usage: emptyPiUsage(),
    stopReason: state.stopReason,
    timestamp: 0,
  };
}

/**
 * Convert one durable Harness assistant message into pi-ai history.
 * @param message - assistant content with required source and optional adapter-owned replay metadata.
 * @returns a native pi-ai assistant message reconstructed from durable content.
 */
export function toPiAssistant(message: Message): AssistantMessage {
  const source = message.source;
  return source.kind !== "model" || source.replayState === undefined
    ? foreignAssistant(message)
    : replayedAssistant(message, source.replayState);
}
