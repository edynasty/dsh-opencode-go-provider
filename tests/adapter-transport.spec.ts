/**
 * Task 5 transport selection contract (red-first).
 *
 * The catalog entry's `api`/`baseUrl` is the ONLY transport selector: one
 * fixture model per protocol reaches exactly its expected endpoint path and
 * never falls through to another protocol on malformed output or metadata
 * mismatch. Unknown models, unowned routes and unsupported options fail before
 * any network with stable codes.
 */
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Protocol } from "../src/types.ts";
import { SSE_DONE, expectedPath, sseData, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { anthropicTextStream, completionsTextStream, responsesTextStream, USAGE } from "./helpers/sse-payloads.ts";
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

const PROTOCOLS: readonly Protocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

/** A minimal happy-path responder for any of the three transports. */
function happyResponder(protocol: Protocol, base: string) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    sseHeaders(response);
    if (request.url === expectedPath(protocol)) {
      response.write(base);
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end("not the expected transport path");
  };
}

/** A responder that writes corrupt bytes and closes. */
function corruptResponder(): (request: IncomingMessage, response: ServerResponse) => void {
  return (_request, response) => {
    sseHeaders(response);
    response.write("this is not a valid SSE payload\n");
    response.end();
  };
}

describe("transport selection from catalog metadata", () => {
  it.each(PROTOCOLS)(
    "routes the %s fixture model to only its expected endpoint",
    async (protocol) => {
      // Given: a catalog naming one model of this protocol against the mock.
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, happyResponder(protocol, happyBody(protocol))));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        // When: one generation request streams.
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        // Then: exactly one request hit the transport's own path and it finished cleanly.
        expect(mock.requests).toHaveLength(1);
        expect(mock.requests[0]?.path).toBe(expectedPath(protocol));
        expect(finishKind(collected)).toBe("stop");
        expect(terminalCode(collected)).toBeUndefined();
      } finally {
        await mock.close();
      }
    },
  );

  it.each(PROTOCOLS)(
    "never falls through to another transport on a corrupt %s stream",
    async (protocol) => {
      // Given: a mock that serves corrupt SSE on the expected path only.
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, corruptResponder()));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        // When: the request streams.
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        // Then: exactly one request to the expected path, one terminal error, no fallback.
        expect(mock.requests).toHaveLength(1);
        expect(mock.requests[0]?.path).toBe(expectedPath(protocol));
        expect(finishKind(collected)).toBe("error");
        expect(terminalCode(collected)).toBeDefined();
      } finally {
        await mock.close();
      }
    },
  );

  it("does not retry another protocol when the baseUrl serves the wrong transport", async () => {
    // Given: an anthropic-metadata model whose baseUrl only answers chat/completions.
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("anthropic-messages", (request, response) => {
      sseHeaders(response);
      if (request.url === "/chat/completions") {
        response.write(sseData({ id: "x", object: "chat.completion.chunk", choices: [] }));
        response.end(SSE_DONE);
        return;
      }
      response.statusCode = 404;
      response.end("not the anthropic path");
    }));
    try {
      const adapter = makeAdapter(() => [
        catalogModelFor("anthropic-messages", mock.baseUrl),
      ]);
      // When: the request streams against the wrong-transport endpoint.
      const collected = await collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["anthropic-messages"]),
          messages: [userMessage("hi")],
        }),
      );
      // Then: only the anthropic path was tried, once, and it failed terminally.
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.path).toBe("/v1/messages");
      expect(finishKind(collected)).toBe("error");
      expect(terminalCode(collected)).toBeDefined();
    } finally {
      await mock.close();
    }
  });
});

describe("pre-network refusal", () => {
  it("rejects an unknown model with UNKNOWN_MODEL and zero requests", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("no-such-model", { messages: [userMessage("hi")] })),
      );
      expect(terminalCode(collected)).toBe("UNKNOWN_MODEL");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("rejects an unowned provider route with NO_ADAPTER and zero requests", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({
          ...optionsFor("deepseek-v4-flash", { messages: [userMessage("hi")] }),
          provider: "not-ours",
        }),
      );
      expect(terminalCode(collected)).toBe("NO_ADAPTER");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("rejects the unsupported stop option with UNSUPPORTED_OPTION and zero requests", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream(optionsFor("deepseek-v4-flash", { messages: [userMessage("hi")], stop: ["bye"] })),
      );
      expect(terminalCode(collected)).toBe("UNSUPPORTED_OPTION");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

/** Per-protocol happy body, reused by the happy responder. */
function happyBody(protocol: Protocol): string {
  if (protocol === "anthropic-messages") return anthropicTextStream(USAGE.anthropic);
  if (protocol === "openai-completions") return completionsTextStream(USAGE.completions);
  return responsesTextStream(USAGE.responses);
}
