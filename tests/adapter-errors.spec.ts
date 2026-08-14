/**
 * Task 5 stable error mapping contract (red-first).
 *
 * HTTP 401/403 → AUTH, 429 → RATE_LIMIT, 5xx → SERVER, connection refusal →
 * TRANSPORT, idle timeout → TIMEOUT, caller abort → ABORTED. Malformed
 * streams produce exactly one terminal error with a stable code, never a
 * hang and never a success. All error paths leave no open mock handle.
 */
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Protocol } from "../src/types.ts";
import { errorResponse, expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { completionsTextStream, USAGE } from "./helpers/sse-payloads.ts";
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

/** A responder answering the expected path with one HTTP error status. */
function statusResponder(protocol: Protocol, status: number) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url === expectedPath(protocol)) {
      errorResponse(response, status, protocol, "provider refused the request");
      return;
    }
    response.statusCode = 404;
    response.end("wrong path");
  };
}

/** A responder that sends one valid delta then stalls forever. */
function stallResponder(): (request: IncomingMessage, response: ServerResponse) => void {
  return (_request, response) => {
    sseHeaders(response);
    response.write(
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    );
    // Intentionally never ends: the idle watchdog must fire.
  };
}

describe("HTTP status mapping", () => {
  it.each([401, 403] as const)("maps %s to AUTH on every transport", async (status) => {
    for (const protocol of PROTOCOLS) {
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, statusResponder(protocol, status)));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        expect(finishKind(collected)).toBe("error");
        expect(terminalCode(collected)).toBe("AUTH");
        expect(mock.requests).toHaveLength(1);
      } finally {
        await mock.close();
      }
    }
  });

  it("maps 429 to RATE_LIMIT on every transport", async () => {
    for (const protocol of PROTOCOLS) {
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, statusResponder(protocol, 429)));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        expect(terminalCode(collected)).toBe("RATE_LIMIT");
      } finally {
        await mock.close();
      }
    }
  });

  it.each([500, 503] as const)("maps %s to SERVER on every transport", async (status) => {
    for (const protocol of PROTOCOLS) {
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, statusResponder(protocol, status)));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        expect(terminalCode(collected)).toBe("SERVER");
      } finally {
        await mock.close();
      }
    }
  });
});

describe("transport failures", () => {
  it("maps a connection refusal to TRANSPORT", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    const baseUrl = mock.baseUrl;
    await mock.close();
    const adapter = makeAdapter(() => [catalogModelFor("openai-completions", baseUrl)]);
    const collected = await collect(
      adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
    );
    expect(terminalCode(collected)).toBe("TRANSPORT");
  });

  it("maps an idle timeout to TIMEOUT with a deterministic single outcome", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-completions", stallResponder()));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)], {
        timeoutMs: 250,
      });
      const collected = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
      );
      expect(terminalCode(collected)).toBe("TIMEOUT");
      const finishes = collected.chunks.filter((c) => c.type === "finish");
      expect(finishes.length).toBeLessThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  it("maps a caller abort to ABORTED and distinguishes it from the idle timeout", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-completions", (request, response) => {
      sseHeaders(response);
      if (request.url === "/chat/completions") {
        const body = completionsTextStream(USAGE.completions).split("\n\n");
        response.write(`${body[0] ?? ""}\n\n`);
        // Stream one delta, then wait for the caller to abort.
        const timer = setTimeout(() => {
          response.write(`${body[1] ?? ""}\n\n`);
          response.end();
        }, 2_000);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      response.statusCode = 404;
      response.end("wrong path");
    }));
    try {
      const controller = new AbortController();
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      // When: the caller aborts after the first delta.
      const collection = collect(
        adapter.stream({
          ...optionsFor(FIXTURE_MODELS["openai-completions"], { signal: controller.signal }),
          messages: [userMessage("hi")],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      const collected = await collection;
      expect(terminalCode(collected)).toBe("ABORTED");
    } finally {
      await mock.close();
    }
  });
});

describe("malformed stream discipline", () => {
  it("yields one terminal error, never a hang, for truncated SSE per transport", async () => {
    for (const protocol of PROTOCOLS) {
      const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol(protocol, (request, response) => {
        sseHeaders(response);
        if (request.url === expectedPath(protocol)) {
          // A valid start then an abrupt close with no terminal event.
          const head =
            protocol === "anthropic-messages"
              ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"role\":\"assistant\",\"content\":[]}}\n\n"
              : protocol === "openai-responses"
                ? "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"status\":\"in_progress\",\"output\":[]}}\n\n"
                : "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n";
          response.write(head);
          response.end();
          return;
        }
        response.statusCode = 404;
        response.end("wrong path");
      }));
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl)]);
        const collected = await collect(
          adapter.stream({ ...optionsFor(FIXTURE_MODELS[protocol]), messages: [userMessage("hi")] }),
        );
        expect(finishKind(collected)).toBe("error");
        expect(terminalCode(collected)).toBeDefined();
        expect(terminalCode(collected)).not.toBe("stop");
        expect(mock.requests).toHaveLength(1);
      } finally {
        await mock.close();
      }
    }
  });

  it("yields one terminal error for a non-JSON SSE line", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, wireProtocol("openai-completions", (request, response) => {
      sseHeaders(response);
      if (request.url === "/chat/completions") {
        response.write("data: {broken json\n\n");
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end("wrong path");
    }));
    try {
      const adapter = makeAdapter(() => [catalogModelFor("openai-completions", mock.baseUrl)]);
      const collected = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
      );
      expect(finishKind(collected)).toBe("error");
      expect(terminalCode(collected)).toBeDefined();
    } finally {
      await mock.close();
    }
  });
});
