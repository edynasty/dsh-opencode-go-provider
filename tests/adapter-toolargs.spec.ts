/**
 * Task 5 remediation: lossless tool-call argument contract (red-first).
 *
 * `StreamChunk` tool arguments remain raw JSON strings: the adapter must
 * publish exactly the accumulated wire deltas — whitespace, numeric spelling,
 * unicode escapes and key order preserved — never a re-serialization of the
 * parsed object. A provider that emits no argument deltas gets a documented
 * deterministic fallback from the assembled end object; a delta sequence that
 * does not form a JSON object is a malformed stream and fails terminally.
 */
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { INVALID_REQUEST } from "../src/errors.ts";
import { expectedPath, sseData, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { completionsChunk } from "./helpers/sse-payloads.ts";
import {
  FIXTURE_MODELS,
  WIRE_NDJSON_PATH,
  collect,
  catalogModelFor,
  finishKind,
  makeAdapter,
  optionsFor,
  terminalCode,
  userMessage,
  wireProtocol,
} from "./helpers/adapter-fixtures.ts";

/** The exact raw JSON the mock streams in fragments; JSON.stringify would corrupt it. */
const RAW_ARGUMENTS = '{"city" : "Bei\\njing", "count": 1e3, "esc": "\\u00e9", "a":1, "b":2}';

/** A completions responder streaming one tool call's arguments in raw fragments. */
function rawToolResponder(fragments: readonly string[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    sseHeaders(response);
    if (request.url === expectedPath("openai-completions")) {
      for (const fragment of fragments) {
        response.write(completionsChunk({ toolCalls: [{ index: 0, arguments: fragment }] }));
      }
      response.write(completionsChunk({}, { finishReason: "tool_calls" }));
      response.write(
        sseData({
          id: "chatcmpl-task5",
          object: "chat.completion.chunk",
          model: "mock",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.statusCode = 404;
    response.end("wrong path");
  };
}

describe("lossless tool-call arguments", () => {
  it("publishes exactly the accumulated raw delta sequence", async () => {
    const fragments = [RAW_ARGUMENTS.slice(0, 18), RAW_ARGUMENTS.slice(18, 42), RAW_ARGUMENTS.slice(42)];
    const mock = await startMock(
      WIRE_NDJSON_PATH,
      wireProtocol("openai-completions", rawToolResponder(fragments)),
    );
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("w")] }),
      );
      expect(terminalCode(collected)).toBeUndefined();
      const end = collected.chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call");
      if (end === undefined || end.type !== "block-end" || end.block.type !== "tool-call") {
        throw new Error("test setup: no tool-call block");
      }
      // The exact raw string, not JSON.stringify of the parsed object.
      expect(end.block.arguments).toBe(RAW_ARGUMENTS);
      expect(JSON.parse(end.block.arguments)).toEqual({ city: "Bei\njing", count: 1000, esc: "é", a: 1, b: 2 });
    } finally {
      await mock.close();
    }
  });

  it("uses a deterministic fallback when the provider emits no argument deltas", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, (request, response, context) => {
      context.setProtocol("anthropic-messages");
      sseHeaders(response);
      if (request.url === expectedPath("anthropic-messages")) {
        const ev = (name: string, payload: unknown): string => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
        response.write(ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
        response.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }));
        response.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        response.write(ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }));
        response.write(ev("message_stop", { type: "message_stop" }));
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end("wrong path");
    });
    try {
      const adapter = makeAdapter(() => [catalogModelFor("anthropic-messages", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["anthropic-messages"]), messages: [userMessage("w")] }),
      );
      expect(finishKind(collected)).toBe("tool-calls");
      const end = collected.chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call");
      if (end === undefined || end.type !== "block-end" || end.block.type !== "tool-call") {
        throw new Error("test setup: no tool-call block");
      }
      expect(end.block.arguments).toBe("{}");
    } finally {
      await mock.close();
    }
  });

  it("fails terminally when the raw delta sequence is not a JSON object", async () => {
    const mock = await startMock(
      WIRE_NDJSON_PATH,
      wireProtocol("openai-completions", rawToolResponder(["[1,", "2]"])),
    );
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("w")] }),
      );
      expect(terminalCode(collected)).toBe(INVALID_REQUEST);
      const finishes = collected.chunks.filter((c) => c.type === "finish");
      expect(finishes.length).toBeLessThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });
});
