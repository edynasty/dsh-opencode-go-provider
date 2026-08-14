/**
 * Task 5 stream translation contract (red-first).
 *
 * pi-ai events map faithfully to DSH `StreamChunk`s: reasoning and text keep
 * their deltas and order, tool-call ids/names and lossless JSON arguments are
 * preserved, usage arrives once before the single terminal finish, and the
 * finish carries durable replay state for successful responses.
 */
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Protocol } from "../src/types.ts";
import { expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import {
  anthropicTextStream,
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
  wireProtocol,
  collect,
  catalogModelFor,
  finishKind,
  makeAdapter,
  optionsFor,
  terminalCode,
  userMessage,
} from "./helpers/adapter-fixtures.ts";

/** A responder serving one pre-rendered SSE body on the expected path. */
function streamBody(protocol: Protocol, body: string) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    sseHeaders(response);
    if (request.url !== expectedPath(protocol)) {
      response.statusCode = 404;
      response.end("wrong path");
      return;
    }
    response.write(body);
    response.end();
  };
}

function textChunks(collected: Awaited<ReturnType<typeof collect>>): readonly unknown[] {
  return collected.chunks;
}

describe("openai-completions stream mapping", () => {
  it("preserves text and reasoning deltas, usage and a single stop finish", async () => {
    // Given: a chat-completions mock streaming text then reasoning.
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-completions", streamBody("openai-completions", completionsTextStream(USAGE.completions))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      // When: the request streams.
      const collected = await collect(
        adapter.stream(optionsFor("deepseek-v4-flash", { messages: [userMessage("hi")] })),
      );
      // Then: deltas keep their order, blocks end assembled, usage precedes finish.
      const chunks = textChunks(collected);
      expect(chunks).toEqual([
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: "Hello " },
        { type: "text-delta", index: 0, text: "world" },
        { type: "block-start", index: 1, blockType: "reasoning" },
        { type: "reasoning-delta", index: 1, text: "deep " },
        { type: "reasoning-delta", index: 1, text: "thought" },
        { type: "block-end", index: 0, block: { type: "text", text: "Hello world" } },
        { type: "block-end", index: 1, block: { type: "reasoning", text: "deep thought" } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
        { type: "finish", reason: { kind: "stop" }, replayState: expect.objectContaining({ kind: "opencode-go", version: 1 }) },
      ]);
    } finally {
      await mock.close();
    }
  });

  it("maps tool calls with exact id/name and lossless JSON arguments", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-completions", streamBody("openai-completions", completionsToolStream(USAGE.completions))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("deepseek-v4-flash", { messages: [userMessage("weather?")] })),
      );
      expect(finishKind(collected)).toBe("tool-calls");
      expect(terminalCode(collected)).toBeUndefined();
      const toolCalls = collected.chunks.filter((c) => c.type === "block-end" && c.block.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const block = toolCalls[0];
      if (block === undefined || block.type !== "block-end") throw new Error("missing tool-call block");
      const call = block.block;
      if (call.type !== "tool-call") throw new Error("unexpected block");
      expect(call.id).toBe("call_1");
      expect(call.name).toBe("get_weather");
      expect(JSON.parse(call.arguments)).toEqual({ city: "Beijing" });
    } finally {
      await mock.close();
    }
  });
});

describe("openai-responses stream mapping", () => {
  it("preserves reasoning and text blocks with usage and a stop finish", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-responses", streamBody("openai-responses", responsesTextStream(USAGE.responses))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-responses", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("gpt-5.6-luna", { messages: [userMessage("hi")] })),
      );
      const chunks = textChunks(collected);
      expect(chunks).toEqual([
        { type: "block-start", index: 0, blockType: "reasoning" },
        { type: "reasoning-delta", index: 0, text: "deep " },
        { type: "reasoning-delta", index: 0, text: "thought" },
        { type: "block-end", index: 0, block: { type: "reasoning", text: "deep thought" } },
        { type: "block-start", index: 1, blockType: "text" },
        { type: "text-delta", index: 1, text: "Hello" },
        { type: "block-end", index: 1, block: { type: "text", text: "Hello" } },
        {
          type: "usage",
          usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 },
        },
        { type: "finish", reason: { kind: "stop" }, replayState: expect.objectContaining({ kind: "opencode-go", version: 1 }) },
      ]);
    } finally {
      await mock.close();
    }
  });

  it("maps function-call items to tool-call chunks with exact ids", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-responses", streamBody("openai-responses", responsesToolStream(USAGE.responses))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-responses", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("gpt-5.6-luna", { messages: [userMessage("weather?")] })),
      );
      expect(finishKind(collected)).toBe("tool-calls");
      const deltas = collected.chunks.filter((c) => c.type === "tool-call-delta");
      expect(deltas.length).toBeGreaterThan(0);
      const first = deltas[0];
      if (first === undefined || first.type !== "tool-call-delta") throw new Error("missing tool-call delta");
      // The Responses API composes the call id from call_id and item id.
      expect(first.id).toBe("call_1|fc_1");
      expect(first.name).toBe("get_weather");
      const ends = collected.chunks.filter((c) => c.type === "block-end" && c.block.type === "tool-call");
      const end = ends[0];
      if (end === undefined || end.type !== "block-end") throw new Error("missing tool-call end");
      if (end.block.type !== "tool-call") throw new Error("unexpected block");
      expect(JSON.parse(end.block.arguments)).toEqual({ city: "Beijing" });
    } finally {
      await mock.close();
    }
  });
});

describe("anthropic-messages stream mapping", () => {
  it("maps thinking and text blocks with usage and a stop finish", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("anthropic-messages", streamBody("anthropic-messages", anthropicTextStream(USAGE.anthropic))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("anthropic-messages", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("minimax-m2.5", { messages: [userMessage("hi")] })),
      );
      const chunks = textChunks(collected);
      expect(chunks).toEqual([
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: "Hello" },
        { type: "block-end", index: 0, block: { type: "text", text: "Hello" } },
        { type: "block-start", index: 1, blockType: "reasoning" },
        { type: "reasoning-delta", index: 1, text: "deep thought" },
        { type: "block-end", index: 1, block: { type: "reasoning", text: "deep thought" } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 9 } },
        { type: "finish", reason: { kind: "stop" }, replayState: expect.objectContaining({ kind: "opencode-go", version: 1 }) },
      ]);
    } finally {
      await mock.close();
    }
  });

  it("maps tool_use blocks to tool-call chunks with exact ids", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("anthropic-messages", streamBody("anthropic-messages", anthropicToolStream(USAGE.anthropic))));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("anthropic-messages", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("minimax-m2.5", { messages: [userMessage("weather?")] })),
      );
      expect(finishKind(collected)).toBe("tool-calls");
      const deltas = collected.chunks.filter((c) => c.type === "tool-call-delta");
      const first = deltas[0];
      if (first === undefined || first.type !== "tool-call-delta") throw new Error("missing delta");
      expect(first.id).toBe("toolu_1");
      expect(first.name).toBe("get_weather");
      const end = collected.chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call");
      if (end === undefined || end.type !== "block-end" || end.block.type !== "tool-call") {
        throw new Error("missing tool-call block");
      }
      expect(JSON.parse(end.block.arguments)).toEqual({ city: "Beijing" });
    } finally {
      await mock.close();
    }
  });
});

describe("terminal outcome discipline", () => {
  it("emits usage then exactly one finish chunk per transport", async () => {
    const cases: readonly [Protocol, string][] = [
      ["openai-completions", completionsTextStream(USAGE.completions)],
      ["openai-responses", responsesTextStream(USAGE.responses)],
      ["anthropic-messages", anthropicTextStream(USAGE.anthropic)],
    ];
    for (const [protocol, body] of cases) {
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, streamBody(protocol, body)));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        const collected = await collect(
          adapter.stream(optionsFor(FIXTURE_MODELS[protocol], { messages: [userMessage("hi")] })),
        );
        const usageCount = collected.chunks.filter((c) => c.type === "usage").length;
        const finishCount = collected.chunks.filter((c) => c.type === "finish").length;
        expect(usageCount).toBe(1);
        expect(finishCount).toBe(1);
        const last = collected.chunks[collected.chunks.length - 1];
        expect(last?.type).toBe("finish");
      } finally {
        await mock.close();
      }
    }
  });
});
