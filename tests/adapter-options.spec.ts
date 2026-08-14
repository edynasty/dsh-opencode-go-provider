/**
 * Task 5 remediation: GenerateOptions field contract (red-first).
 *
 * Every field of the current public `GenerateOptions` type is either mapped
 * with observable wire semantics or rejected pre-network with a stable code.
 * `purpose` has no documented pi-ai public field with exact semantics, so it
 * is rejected explicitly rather than silently ignored.
 */
import { describe, expect, it } from "vitest";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { UNSUPPORTED_OPTION } from "../src/errors.ts";
import { expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { completionsTextStream, USAGE } from "./helpers/sse-payloads.ts";
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

describe("GenerateOptions.purpose", () => {
  it.each(["compaction", "session-title"] as const)(
    "rejects purpose %s with UNSUPPORTED_OPTION before network",
    async (purpose) => {
      const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
      try {
        const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)], { timeoutMs: 250 });
        const collected = await collect(
          adapter.stream({
            ...optionsFor(FIXTURE_MODELS["openai-completions"], {
              purpose,
              messages: [userMessage("hi")],
            }),
          }),
        );
        expect(terminalCode(collected)).toBe(UNSUPPORTED_OPTION);
        expect(mock.requests).toHaveLength(0);
      } finally {
        await mock.close();
      }
    },
  );
});

describe("supported GenerateOptions fields reach the wire", () => {
  it("maps system, temperature, maxTokens and a supported reasoningEffort into the completions request", async () => {
    const bodies: string[] = [];
    const mock = await startMock(WIRE_NDJSON_PATH, async (request, response, context) => {
      context.setProtocol("openai-completions");
      bodies.push(await context.body());
      if (request.url === expectedPath("openai-completions")) {
        sseHeaders(response);
        response.write(completionsTextStream(USAGE.completions));
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end("wrong path");
    });
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["openai-completions"], {
            system: "You are the wire-probe assistant.",
            temperature: 0.5,
            maxTokens: 128,
            reasoningEffort: ReasoningEffortId("medium"),
            messages: [userMessage("hi")],
          }),
        }),
      );
      expect(terminalCode(collected)).toBeUndefined();
      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(body).toContain("You are the wire-probe assistant.");
      expect(body).toContain('"temperature":0.5');
      expect(body).toContain('"max_completion_tokens":128');
      expect(body).toContain('"reasoning_effort":"medium"');
    } finally {
      await mock.close();
    }
  });
});
