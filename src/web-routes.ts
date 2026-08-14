/**
 * Same-origin Web routes bridging the browser Connect card to the control
 * seam.
 *
 * The routes are registered on the public `ctx.webServer` service exactly like
 * the shipped dsh-codex-connect browser bridge: inside `ctx.inject(['webServer'])`
 * so a headless profile never touches them, each registration rides the
 * plugin fiber, and every handler guards method + loopback origin, emits
 * no-store JSON, and returns fixed error categories — never raw bodies, keys
 * or fs text. The connect key travels once in the request body and reaches
 * exactly one place: `control.connect`, which validates and stores it through
 * the DSH credentials service.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { ProviderControl } from "./control.ts";
import { isRecord } from "./guards.ts";

export const CONTROL_ROUTES = {
  status: "/plugins/dsh-opencode-go/status",
  connect: "/plugins/dsh-opencode-go/connect",
  disconnect: "/plugins/dsh-opencode-go/disconnect",
  doctor: "/plugins/dsh-opencode-go/doctor",
} as const;

const MAX_BODY_BYTES = 64 * 1024;

/** Fatal UTF-8 decoder: any malformed byte throws instead of becoming U+FFFD. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Pure byte-bounded body accumulator. `accept` retains RAW BUFFER CHUNKS and
 * counts their byte lengths; once the limit is exceeded it stops retaining
 * anything (so the exposed chunk list never grows unbounded) and the body is
 * decoded exactly once after completion via `decode`. Decoding is FATAL:
 * malformed UTF-8 throws rather than expanding into replacement characters
 * (which would let 4 invalid bytes inflate to 12 output bytes), so a decoded
 * string can never re-encode to more bytes than were retained.
 */
export interface BodyAccumulator {
  readonly overflowed: boolean;
  readonly accept: (chunk: Buffer) => void;
  readonly decode: () => string;
}

/** The largest end <= `end` that does not split a UTF-8 sequence. */
function utf8Boundary(buffer: Buffer, end: number): number {
  let continuations = 0;
  let cut = end;
  while (cut > 0 && (buffer[cut - 1]! & 0xc0) === 0x80) {
    cut -= 1;
    continuations += 1;
  }
  if (cut === 0) return 0;
  const lead = buffer[cut - 1]!;
  if (lead < 0x80) return end;
  const needed = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : 1;
  return continuations >= needed ? end : cut - 1;
}

export function createBodyAccumulator(limit: number): BodyAccumulator {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  let decoded: string | undefined;
  return {
    get overflowed(): boolean {
      return overflowed;
    },
    accept: (chunk) => {
      if (overflowed) return;
      const room = limit - total;
      if (room <= 0 || chunk.byteLength > room) {
        if (room > 0) {
          // Keep only complete UTF-8 sequences: a truncated multibyte tail
          // would decode into replacement characters that inflate past limit.
          const kept = utf8Boundary(chunk, room);
          if (kept > 0) {
            chunks.push(chunk.subarray(0, kept));
            total += kept;
          }
        }
        overflowed = true;
        decoded = undefined;
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      decoded = undefined;
    },
    decode: () => {
      if (decoded === undefined) {
        decoded = utf8Decoder.decode(Buffer.concat(chunks));
      }
      return decoded;
    },
  };
}

/** A typed refusal with its fixed HTTP status and error category. */
class RouteError extends Error {
  constructor(readonly status: number, readonly category: string) {
    super(`route refused (${category})`);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

/** Only loopback-origin same-page requests may reach the control plane. */
function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function methodOf(req: IncomingMessage): string {
  return typeof req.method === "string" ? req.method.toUpperCase() : "";
}

/** Read the request body up to a fixed bound; larger bodies fail closed. */
function readBoundedBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const accumulator = createBodyAccumulator(MAX_BODY_BYTES);
    let settled = false;
    const fail = (error: RouteError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      // Keep draining the stream after overflow, but never retain more bytes.
      accumulator.accept(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (accumulator.overflowed) {
        reject(new RouteError(413, "body too large"));
      } else {
        try {
          resolve(accumulator.decode());
        } catch {
          reject(new RouteError(400, "invalid UTF-8 request body"));
        }
      }
    });
    req.on("error", () => fail(new RouteError(400, "body unreadable")));
  });
}

/** Refuse any nonempty body before a side-effect-free POST action runs. */
function rejectNonemptyBody(body: string): void {
  if (body.length > 0) {
    throw new RouteError(400, "expected an empty body");
  }
}

/** Extract the request's key payload; a malformed body is refused before control. */
function parseKeyBody(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.key !== "string") return undefined;
  return value.key;
}

/** Route handler template: method gate, trust gate, control call, JSON reply. */
function controlHandler(
  method: string,
  run: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (methodOf(req) !== method) {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!trustedRequest(req)) {
      json(res, 403, { error: "forbidden" });
      return;
    }
    try {
      json(res, 200, await run(req, res));
    } catch (error) {
      if (error instanceof RouteError) {
        json(res, error.status, { error: error.category });
      } else {
        json(res, 500, { error: "request failed" });
      }
    }
  };
}

/** Register the four control routes; each registration rides the plugin fiber. */
export function registerControlRoutes(ctx: Context, control: ProviderControl): void {
  ctx.effect(
    () => {
      const disposers = [
        ctx.webServer.register({
          kind: "exact",
          path: CONTROL_ROUTES.status,
          handler: controlHandler("GET", async () => control.status()),
        }),
        ctx.webServer.register({
          kind: "exact",
          path: CONTROL_ROUTES.connect,
          handler: controlHandler("POST", async (req) => {
            const key = parseKeyBody(await readBoundedBody(req));
            if (key === undefined) {
              throw new RouteError(400, "invalid request");
            }
            return control.connect(key);
          }),
        }),
        ctx.webServer.register({
          kind: "exact",
          path: CONTROL_ROUTES.disconnect,
          handler: controlHandler("POST", async (req) => {
            rejectNonemptyBody(await readBoundedBody(req));
            return control.disconnect();
          }),
        }),
        ctx.webServer.register({
          kind: "exact",
          path: CONTROL_ROUTES.doctor,
          handler: controlHandler("POST", async (req) => {
            rejectNonemptyBody(await readBoundedBody(req));
            return control.doctor();
          }),
        }),
      ];
      return () => {
        for (const dispose of disposers) {
          dispose();
        }
      };
    },
    "dsh-opencode-go-provider: control routes",
  );
}
