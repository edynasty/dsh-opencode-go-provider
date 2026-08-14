/**
 * Task 5 remediation: test-helper contracts (red-first).
 *
 * Async responders must be awaited and their rejections converted into a
 * deterministic 500 response — never an unhandled rejection that hangs or
 * silently loses the request. The shared `collect()` helper must normalize
 * only genuine `LlmError`s: any other thrown value is rethrown, so a crash in
 * the provider/replay path can never masquerade as a clean stream.
 */
import { describe, expect, it } from "vitest";
import { startMock } from "./helpers/mock-server.ts";
import { collect } from "./helpers/adapter-fixtures.ts";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

describe("mock-server async responders", () => {
  it("awaits an async responder and records its request", async () => {
    let observed = false;
    const mock = await startMock(undefined, async (request, response, context) => {
      context.setProtocol("openai-completions");
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed = request.url === "/chat/completions";
      response.setHeader("content-type", "text/event-stream");
      response.end("data: [DONE]\n\n");
    });
    try {
      const result = await fetch(`${mock.baseUrl}/chat/completions`, { method: "POST" });
      expect(result.status).toBe(200);
      expect(observed).toBe(true);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("converts a rejected async responder into a deterministic 500", async () => {
    const mock = await startMock(undefined, async () => {
      throw new Error("responder boom");
    });
    try {
      const result = await fetch(`${mock.baseUrl}/any`, { method: "POST" });
      expect(result.status).toBe(500);
      expect(mock.facts).toHaveLength(1);
      expect(mock.facts[0]?.status).toBe(500);
    } finally {
      await mock.close();
    }
  });
});

describe("collect normalization", () => {
  it("rethrows a plain TypeError from an async iterable instead of reporting a clean stream", async () => {
    // Given: an async generator that throws a non-LlmError mid-stream.
    async function* crashing(): AsyncIterable<StreamChunk> {
      yield { type: "block-start", index: 0, blockType: "text" };
      throw new TypeError("provider conversion exploded");
    }
    // When: the shared collector consumes it.
    const rejection = collect(crashing());
    // Then: the collector rejects with the original TypeError — never resolves
    // with { thrown: undefined }, which would make a crash look like success.
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps normalizing a genuine LlmError into the thrown slot", async () => {
    const { LlmError } = await import("@deepseek-ai/dsh-llm");
    async function* failing(): AsyncIterable<StreamChunk> {
      throw new LlmError("boom", "UNKNOWN_MODEL");
    }
    const collected = await collect(failing());
    expect(collected.thrown?.code).toBe("UNKNOWN_MODEL");
    expect(collected.chunks).toEqual([]);
  });
});
