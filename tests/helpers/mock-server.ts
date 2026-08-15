/**
 * Loopback mock server for the Task 5 wire-level adapter specs.
 *
 * Each request is captured as a sanitized fact: method, path, content-type,
 * status, the redacted auth marker and the SSE event sequence. Facts are
 * appended to the Task 5 wire evidence file when one is configured — the
 * captured payload never includes header values or request bodies, so the
 * evidence stays secret-free by construction.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Protocol } from "../../src/types.ts";

/** Mutable fact being assembled while a request is in flight. */
interface FactBuilder {
  protocol: string;
  method: string;
  path: string;
  contentType: string | undefined;
  status: number;
  authMarker: "bearer" | "key" | "none";
  events: string[];
}

/** Sanitized per-request fact safe for evidence files. */
export interface WireFact {
  readonly protocol: string;
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly status: number;
  /** "bearer" when an Authorization: Bearer header was sent, "key" for x-api-key, "none" otherwise. */
  readonly authMarker: "bearer" | "key" | "none";
  /** Ordered SSE event names written by the mock, when the handler marks them. */
  readonly events: readonly string[];
}

/** Request facts recorded in-memory for assertions (bodies are test-local, never evidence). */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly hasAuthorization: boolean;
  readonly body: string;
}

export interface MockContext {
  /** Append one SSE event name to the in-flight request's fact. */
  markEvent(event: string): void;
  /** Name the wire protocol for the in-flight request's fact. */
  setProtocol(protocol: string): void;
  /** Read the full request body. */
  body(): Promise<string>;
}

export interface MockHandle {
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  readonly facts: readonly WireFact[];
  readonly close: () => Promise<void>;
}

/** A responder may be sync or async; rejections must be observed. */
export type MockResponder = (
  request: IncomingMessage,
  response: ServerResponse,
  context: MockContext,
) => void | Promise<void>;

/** Frame one JSON object as a `data:` SSE line. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Frame one JSON object as an Anthropic `event:` + `data:` SSE pair. */
export function sseAnthropic(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The standard SSE stream terminator. */
export const SSE_DONE = "data: [DONE]\n\n";

function authMarkerOf(request: IncomingMessage): WireFact["authMarker"] {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return "bearer";
  if (typeof authorization === "string" && authorization.length > 0) return "key";
  if (typeof request.headers["x-api-key"] === "string") return "key";
  return "none";
}

/** Extract the SSE event names a written response body carries. */
function sseEventSequence(text: string): readonly string[] {
  const events: string[] = [];
  for (const match of text.matchAll(/event: (\S+)/g)) {
    const name = match[1];
    if (name !== undefined) events.push(name);
  }
  for (const match of text.matchAll(/"type":"([\w.]+)"/g)) {
    const name = match[1];
    if (name !== undefined && !events.some((entry) => entry === name)) events.push(name);
  }
  for (const match of text.matchAll(/"finish_reason":"([\w]+)"/g)) {
    const name = match[1];
    if (name !== undefined) events.push(`finish_reason:${name}`);
  }
  if (text.includes("data: [DONE]")) events.push("stream_done");
  return events;
}

/**
 * Start a loopback mock server. Each request is recorded (sanitized) and the
 * test's responder writes the response. `ndjsonPath` optionally receives one
 * sanitized fact per request; when given, its parent directory is created
 * recursively BEFORE the server starts accepting requests, so a missing
 * parent surfaces as a deterministic startMock rejection instead of an
 * unhandled ENOENT from the response-finish append.
 */
export async function startMock(
  ndjsonPath: string | undefined,
  respond: MockResponder,
): Promise<MockHandle> {
  if (ndjsonPath !== undefined) {
    mkdirSync(dirname(ndjsonPath), { recursive: true });
  }
  const requests: RecordedRequest[] = [];
  const facts: WireFact[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = request.url ?? "/";
      const contentType = request.headers["content-type"];
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        path,
        contentType: typeof contentType === "string" ? contentType : undefined,
        hasAuthorization: authMarkerOf(request) !== "none",
        body,
      };
      requests.push(recorded);
      const events: string[] = [];
      const fact: FactBuilder = {
        protocol: "unknown",
        method: recorded.method,
        path,
        contentType: recorded.contentType,
        status: 200,
        authMarker: authMarkerOf(request),
        events,
      };
      facts.push(fact);
      const responseText: string[] = [];
      const originalWrite = response.write.bind(response);
      response.write = (
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        if (typeof chunk === "string") responseText.push(chunk);
        if (typeof encoding === "function") return originalWrite(chunk, encoding);
        if (encoding === undefined) {
          return callback === undefined ? originalWrite(chunk) : originalWrite(chunk, callback);
        }
        return callback === undefined ? originalWrite(chunk, encoding) : originalWrite(chunk, encoding, callback);
      };
      response.on("finish", () => {
        fact.status = response.statusCode;
        events.push(...sseEventSequence(responseText.join("")));
        if (ndjsonPath !== undefined) {
          appendFileSync(ndjsonPath, `${JSON.stringify(fact)}\n`);
        }
      });
      const context: MockContext = {
        markEvent: (event) => {
          events.push(event);
        },
        setProtocol: (protocol) => {
          fact.protocol = protocol;
        },
        body: () => Promise.resolve(body),
      };
      try {
        const outcome = respond(request, response, context);
        if (outcome instanceof Promise) {
          // An async responder's rejection becomes a deterministic 500 the
          // client can observe, never an unhandled rejection.
          void outcome.catch((error: unknown) => {
            if (!response.writableEnded) {
              response.statusCode = 500;
              response.end(`mock handler rejected: ${String(error)}`);
            }
          });
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(`mock handler error: ${String(error)}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test setup: mock server bound to no loopback address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    facts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** The endpoint path the mock for one protocol must receive. */
export function expectedPath(protocol: Protocol): string {
  switch (protocol) {
    case "openai-completions":
      return "/chat/completions";
    case "openai-responses":
      return "/responses";
    case "anthropic-messages":
      return "/v1/messages";
  }
}

/** A status-code error response with a JSON error body (as the SDKs parse). */
export function errorResponse(
  response: ServerResponse,
  status: number,
  protocol: Protocol,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  if (protocol === "anthropic-messages") {
    response.end(JSON.stringify({ type: "error", error: { type: "error", message } }));
    return;
  }
  response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

/** Write an SSE response header set the SDK stream parsers accept. */
export function sseHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache");
  response.setHeader("connection", "keep-alive");
}
