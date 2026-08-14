/**
 * Task 5 assistant replay contract (red-first, remediation-extended).
 *
 * A successful response's terminal finish carries durable replay state; feeding
 * the durable assistant message back into the next request reconstructs the
 * provider-native assistant history — reasoning/thinking and tool continuation
 * included — in the SDK message format each transport expects. Malformed
 * durable tool-call arguments and unsupported replay metadata fail before
 * network with INVALID_REPLAY_STATE, and an uncorrelated tool result fails
 * with INVALID_REQUEST instead of fabricating a toolName.
 */
import { describe, expect, it } from "vitest";
import { CallId, createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { INVALID_REPLAY_STATE, INVALID_REQUEST } from "../src/errors.ts";
import { isRecord } from "../src/guards.ts";
import type { Protocol } from "../src/types.ts";
import { expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import {
  anthropicThinkingStream,
  anthropicToolStream,
  completionsTextStream,
  completionsToolStream,
  responsesTextStream,
  responsesToolStream,
  USAGE,
} from "./helpers/sse-payloads.ts";
import {
  FIXTURE_MODELS,
  WIRE_NDJSON_PATH,
  collect,
  catalogModelFor,
  makeAdapter,
  optionsFor,
  terminalCode,
  userMessage,
} from "./helpers/adapter-fixtures.ts";

/** A record accessor that fails the test setup on a non-object value. */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`test setup: ${what} is not an object`);
  return value;
}

/** The first element of an array, narrowed to a record, or undefined. */
function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entry = value[0];
  return isRecord(entry) ? entry : undefined;
}

/** Capture the durable blocks of the first stream run, in stream order. */
function durableBlocks(
  collected: Awaited<ReturnType<typeof collect>>,
): import("@deepseek-ai/dsh-llm").ContentBlock[] {
  const blocks: import("@deepseek-ai/dsh-llm").ContentBlock[] = [];
  for (const chunk of collected.chunks) {
    if (chunk.type === "block-end") blocks.push(chunk.block);
  }
  if (blocks.length === 0) throw new Error("test setup: stream produced no blocks");
  return blocks;
}

/** Capture the durable replay state from the finish chunk. */
function replayState(collected: Awaited<ReturnType<typeof collect>>): unknown {
  const finish = collected.chunks.find((c) => c.type === "finish");
  if (finish === undefined || finish.type !== "finish" || finish.replayState === undefined) {
    throw new Error("test setup: stream produced no replay state");
  }
  return finish.replayState;
}

/** One mock that records every request body and serves the given stream body. */
async function recordingMock(protocol: Protocol, body: string): Promise<{
  readonly bodies: string[];
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const mock = await startMock(WIRE_NDJSON_PATH, async (request, response, context) => {
    context.setProtocol(protocol);
    bodies.push(await context.body());
    if (request.url === expectedPath(protocol)) {
      sseHeaders(response);
      response.write(body);
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end("wrong path");
  });
  return { bodies, baseUrl: mock.baseUrl, close: mock.close };
}

const TOOL_BODIES: Readonly<Record<Protocol, string>> = {
  "openai-completions": completionsToolStream(USAGE.completions),
  "openai-responses": responsesToolStream(USAGE.responses),
  "anthropic-messages": anthropicToolStream(USAGE.anthropic),
};

const REASONING_BODIES: Readonly<Record<Protocol, string>> = {
  "openai-completions": completionsTextStream(USAGE.completions),
  "openai-responses": responsesTextStream(USAGE.responses),
  "anthropic-messages": anthropicThinkingStream(USAGE.anthropic),
};

const PROTOCOLS: readonly Protocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

/** The replayed tool call facts each transport's wire body carries (cast-free). */
function replayedToolCall(protocol: Protocol, body: string): { readonly id: string; readonly name: string; readonly args: string } {
  const parsed = requireRecord(JSON.parse(body), "request body");
  if (protocol === "openai-completions") {
    const messages = parsed["messages"];
    if (!Array.isArray(messages)) throw new Error("test setup: completions body has no messages");
    const assistant = messages.find((entry) => {
      if (!isRecord(entry)) return false;
      return Array.isArray(entry["tool_calls"]) && entry["tool_calls"].length > 0;
    });
    const call = firstRecord(isRecord(assistant) ? assistant["tool_calls"] : undefined);
    const fn = call === undefined ? undefined : call["function"];
    const fnRecord = isRecord(fn) ? fn : undefined;
    return {
      id: String(call?.["id"] ?? ""),
      name: String(fnRecord?.["name"] ?? ""),
      args: String(fnRecord?.["arguments"] ?? ""),
    };
  }
  if (protocol === "openai-responses") {
    const input = parsed["input"];
    if (!Array.isArray(input)) throw new Error("test setup: responses body has no input");
    const call = input.find((entry) => isRecord(entry) && entry["type"] === "function_call");
    const callRecord = isRecord(call) ? call : undefined;
    return {
      id: String(callRecord?.["call_id"] ?? ""),
      name: String(callRecord?.["name"] ?? ""),
      args: String(callRecord?.["arguments"] ?? ""),
    };
  }
  const messages = parsed["messages"];
  if (!Array.isArray(messages)) throw new Error("test setup: anthropic body has no messages");
  const assistant = messages.find((entry) => isRecord(entry) && entry["role"] === "assistant");
  const content = isRecord(assistant) ? assistant["content"] : undefined;
  const toolUse = Array.isArray(content)
    ? content.find((block) => isRecord(block) && block["type"] === "tool_use")
    : undefined;
  const block = isRecord(toolUse) ? toolUse : undefined;
  return {
    id: String(block?.["id"] ?? ""),
    name: String(block?.["name"] ?? ""),
    args: JSON.stringify(block?.["input"]),
  };
}

describe("assistant replay preserves tool continuation", () => {
  it.each(PROTOCOLS)(
    "reconstructs the %s assistant tool call in the next request",
    async (protocol) => {
      // Given: one mock recording every request body and serving the tool stream.
      const mock = await recordingMock(protocol, TOOL_BODIES[protocol]);
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        // When: the first turn produces a tool call, then the second turn replays it.
        const first = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("weather?")] }),
        );
        expect(terminalCode(first)).toBeUndefined();
        const blocks = durableBlocks(first);
        const toolBlock = blocks.find((block) => block.type === "tool-call");
        if (toolBlock === undefined || toolBlock.type !== "tool-call") {
          throw new Error("test setup: no durable tool-call block");
        }
        const durable = createAssistantMessage({
          content: blocks,
          source: { provider: "opencode-go", model: FIXTURE_MODELS[protocol], replayState: replayState(first) },
        });
        const second = await collect(
          adapter.stream({
            ...optionsFor(FIXTURE_MODELS[protocol], { messages: [userMessage("weather?"), durable] }),
          }),
        );
        // Then: the replay request's wire body carries the tool call's exact
        // id, name and JSON arguments in the transport's own shape.
        expect(terminalCode(second)).toBeUndefined();
        expect(mock.bodies).toHaveLength(2);
        const replayed = replayedToolCall(protocol, mock.bodies[1] ?? "");
        expect(replayed.id).toBe(toolBlock.id.split("|")[0] ?? toolBlock.id);
        expect(replayed.name).toBe(toolBlock.name);
        expect(JSON.parse(replayed.args)).toEqual(JSON.parse(toolBlock.arguments));
      } finally {
        await mock.close();
      }
    },
  );
});

describe("assistant replay preserves reasoning", () => {
  it.each(PROTOCOLS)("replays the %s reasoning block on the second request", async (protocol) => {
    // Given: a mock serving a reasoning+text stream and recording bodies.
    const mock = await recordingMock(protocol, REASONING_BODIES[protocol]);
    try {
      const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
      // When: the first turn emits reasoning+text, then the second turn replays them.
      const first = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("think?")] }),
      );
      expect(terminalCode(first)).toBeUndefined();
      const blocks = durableBlocks(first);
      const reasoning = blocks.find((block) => block.type === "reasoning");
      const text = blocks.find((block) => block.type === "text");
      if (reasoning === undefined || reasoning.type !== "reasoning" || text === undefined || text.type !== "text") {
        throw new Error("test setup: stream produced no reasoning/text blocks");
      }
      const durable = createAssistantMessage({
        content: blocks,
        source: { provider: "opencode-go", model: FIXTURE_MODELS[protocol], replayState: replayState(first) },
      });
      const second = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS[protocol], { messages: [userMessage("think?"), durable] }),
        }),
      );
      // Then: the wire body keeps the provider-native reasoning representation.
      expect(terminalCode(second)).toBeUndefined();
      expect(mock.bodies).toHaveLength(2);
      const body = mock.bodies[1] ?? "";
      if (protocol === "anthropic-messages") {
        const parsed = requireRecord(JSON.parse(body), "anthropic body");
        const messages = parsed["messages"];
        if (!Array.isArray(messages)) throw new Error("test setup: anthropic body has no messages");
        const assistant = messages.find((entry) => isRecord(entry) && entry["role"] === "assistant");
        const content = isRecord(assistant) ? assistant["content"] : undefined;
        const thinking = Array.isArray(content)
          ? content.find((block) => isRecord(block) && block["type"] === "thinking")
          : undefined;
        const thinkingRecord = isRecord(thinking) ? thinking : undefined;
        expect(thinkingRecord?.["thinking"]).toBe(reasoning.text);
        expect(thinkingRecord?.["signature"]).toBe("sig-abc-123");
      } else if (protocol === "openai-completions") {
        const parsed = requireRecord(JSON.parse(body), "completions body");
        const messages = parsed["messages"];
        if (!Array.isArray(messages)) throw new Error("test setup: completions body has no messages");
        const assistant = messages.find((entry) => isRecord(entry) && entry["role"] === "assistant");
        const assistantRecord = isRecord(assistant) ? assistant : undefined;
        expect(assistantRecord?.["reasoning_content"]).toBe(reasoning.text);
      } else {
        const parsed = requireRecord(JSON.parse(body), "responses body");
        const input = parsed["input"];
        if (!Array.isArray(input)) throw new Error("test setup: responses body has no input");
        const item = input.find((entry) => isRecord(entry) && entry["type"] === "reasoning");
        const itemRecord = isRecord(item) ? item : undefined;
        expect(itemRecord).toBeDefined();
        expect(JSON.stringify(itemRecord)).toContain(reasoning.text);
      }
    } finally {
      await mock.close();
    }
  });
});

describe("malformed durable tool-call arguments", () => {
  it.each(["not json", "[1,2]", "null", "42", '"str"'] as const)(
    "rejects %s with INVALID_REPLAY_STATE before network",
    async (raw) => {
      const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
      try {
        const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
        const durable = createAssistantMessage({
          content: [{ type: "tool-call", id: CallId("call_1"), name: "get_weather", arguments: raw }],
          source: { provider: "opencode-go", model: FIXTURE_MODELS["openai-completions"] },
        });
        const collected = await collect(
          adapter.stream({
            ...optionsFor(FIXTURE_MODELS["openai-completions"], { messages: [userMessage("w?"), durable] }),
          }),
        );
        expect(terminalCode(collected)).toBe(INVALID_REPLAY_STATE);
        expect(mock.requests).toHaveLength(0);
      } finally {
        await mock.close();
      }
    },
  );

  it("rejects malformed arguments even with valid replay metadata, before network", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)], { timeoutMs: 250 });
      const durable = createAssistantMessage({
        content: [{ type: "tool-call", id: CallId("call_1"), name: "get_weather", arguments: "{oops" }],
        source: {
          provider: "opencode-go",
          model: FIXTURE_MODELS["openai-completions"],
          replayState: {
            kind: "opencode-go",
            version: 1,
            api: "openai-completions",
            provider: "opencode-go",
            model: FIXTURE_MODELS["openai-completions"],
            stopReason: "toolUse",
            blocks: [{ type: "tool-call" }],
          },
        },
      });
      const collected = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["openai-completions"], { messages: [userMessage("w?"), durable] }),
        }),
      );
      expect(terminalCode(collected)).toBe(INVALID_REPLAY_STATE);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe("unsupported replay metadata", () => {
  it("rejects a replay state naming an unsupported api before network", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)], { timeoutMs: 250 });
      const durable = createAssistantMessage({
        content: [{ type: "text", text: "hi" }],
        source: {
          provider: "opencode-go",
          model: FIXTURE_MODELS["openai-completions"],
          replayState: {
            kind: "opencode-go",
            version: 1,
            api: "bedrock-converse-stream",
            provider: "opencode-go",
            model: FIXTURE_MODELS["openai-completions"],
            stopReason: "stop",
            blocks: [{ type: "text" }],
          },
        },
      });
      const collected = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["openai-completions"], { messages: [userMessage("hi"), durable] }),
        }),
      );
      expect(terminalCode(collected)).toBe(INVALID_REPLAY_STATE);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe("uncorrelated tool result", () => {
  it("fails with INVALID_REQUEST before network instead of emitting toolName unknown", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)], { timeoutMs: 250 });
      const result = createToolResultMessage({
        callId: CallId("ghost-call-1"),
        content: [{ type: "text", text: "no output" }],
        isError: false,
      });
      const collected = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["openai-completions"], { messages: [userMessage("w?"), result] }),
        }),
      );
      expect(terminalCode(collected)).toBe(INVALID_REQUEST);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
