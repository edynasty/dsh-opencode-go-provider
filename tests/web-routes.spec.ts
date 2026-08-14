/**
 * Task 7 Host web-route bridge integration (red-first).
 *
 * The browser card's control plane is registered on the REAL public
 * `ctx.webServer` service (the same mechanism the shipped dsh-codex-connect
 * browser bridge uses) and is exercised over a real loopback HTTP server:
 * connect stores the key through the DSH credentials service, status reports
 * sanitized facts, disconnect removes only the credential, and doctor issues
 * the injected authenticated GET /models. Disposing the plugin fiber
 * withdraws every route (subsequent requests 404). The trust and method
 * gates are proven over the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCredentials, MemorySettings, mountPlugin } from "./helpers/context-harness.ts";
import { CONTROL_ROUTES, createBodyAccumulator } from "../src/web-routes.ts";
import { isRecord } from "../src/guards.ts";
import type { SyncFetch, SyncResponse } from "../src/sync.ts";

const FAKE_KEY = "sk-web-fake-key-0123456789abcdef";
const NEW_KEY = "sk-web-new-key-abcdef0123456789";
const DERIVED_LIVE_URL = "https://opencode.ai/zen/go/v1/models";

function hostFetch(): SyncFetch {
  return async (url): Promise<SyncResponse> => {
    if (url === "https://models.opencode.ai/api.json") {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ "opencode-go": { id: "opencode-go", name: "OpenCode Go", models: {} } })),
      });
    }
    if (url === DERIVED_LIVE_URL) {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: "grok-4.5" }, { id: "gpt-5.6" }] })),
      });
    }
    throw new Error(`test guard: unexpected URL ${url}`);
  };
}

interface BootWeb {
  readonly ctx: Context;
  readonly fiber: Awaited<ReturnType<typeof mountPlugin>>;
  readonly webFiber: Awaited<ReturnType<typeof mountPlugin>>;
  readonly credentials: MemoryCredentials;
  readonly baseUrl: string;
  readonly home: string;
}

const booted: BootWeb[] = [];
afterEach(async () => {
  for (const entry of booted.splice(0)) {
    try {
      await entry.fiber.dispose();
    } catch {
      // an already-disposed fiber is a no-op for cleanup purposes
    }
    try {
      await entry.webFiber.dispose();
    } catch {
      // an already-disposed fiber is a no-op for cleanup purposes
    }
    await rm(entry.home, { recursive: true, force: true });
  }
});

async function bootWeb(): Promise<BootWeb> {
  const ctx = new Context();
  const webFiber = await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  const credentials = new MemoryCredentials(ctx);
  await credentials.set(credentialRef("OPENCODE_GO_API_KEY"), FAKE_KEY);
  void new LlmRuntime(ctx);
  await ctx.plugin(MemorySettings, {});
  ctx.provide("opencodeGoFetch", hostFetch());
  const home = mkdtempSync(join(tmpdir(), "dsh-opencode-go-web-"));
  ctx.provide("opencodeGoHome", home);
  const fiber = await mountPlugin(ctx);
  const entry: BootWeb = {
    ctx,
    fiber,
    webFiber,
    credentials,
    baseUrl: `http://127.0.0.1:${ctx.webServer.port}`,
    home,
  };
  booted.push(entry);
  return entry;
}

async function httpJson(
  baseUrl: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body: value };
}

function record(body: unknown): Record<string, unknown> {
  if (isRecord(body)) return body;
  throw new Error("test: expected a JSON object response");
}

describe("control web routes over the real WebServer", () => {
  it("status reports the configured credential and sanitized lifecycle facts", async () => {
    const { baseUrl } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.status, "GET");
    expect(status).toBe(200);
    const value = record(body);
    expect(value.configured).toBe(true);
    expect(value.origin).toBe("embedded");
    expect(typeof value.modelCount).toBe("number");
    expect(typeof value.refreshedAt).toBe("string");
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it("connect stores the key through the credentials service and never returns it", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.connect, "POST", { key: NEW_KEY });
    expect(status).toBe(200);
    const value = record(body);
    expect(value.kind).toBe("connected");
    expect(JSON.stringify(body)).not.toContain(NEW_KEY);
    const resolved = await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"));
    expect(resolved?.value).toBe(NEW_KEY);
  });

  it("disconnect removes only the credential and leaves the route registered", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.disconnect, "POST");
    expect(status).toBe(200);
    expect(record(body).kind).toBe("disconnected");
    expect(await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"))).toBeUndefined();
    const statusResponse = await httpJson(baseUrl, CONTROL_ROUTES.status, "GET");
    expect(record(statusResponse.body).configured).toBe(false);
  });

  it("doctor issues exactly one authenticated GET /models and reports the sanitized count", async () => {
    const { baseUrl } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.doctor, "POST");
    expect(status).toBe(200);
    const value = record(body);
    expect(value.kind).toBe("configured");
    expect(value.liveModelCount).toBe(2);
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it("refuses a malformed connect body with a fixed category before the control seam", async () => {
    const { baseUrl } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.connect, "POST", { notAKey: true });
    expect(status).toBe(400);
    expect(record(body).error).toBe("invalid request");
  });

  it("refuses a wrong method with 405", async () => {
    const { baseUrl } = await bootWeb();
    const { status, body } = await httpJson(baseUrl, CONTROL_ROUTES.status, "POST");
    expect(status).toBe(405);
    expect(record(body).error).toBe("method not allowed");
  });

  it("disposing the plugin fiber withdraws every route (404 afterwards)", async () => {
    const { baseUrl, fiber } = await bootWeb();
    await fiber.dispose();
    const { status } = await httpJson(baseUrl, CONTROL_ROUTES.status, "GET");
    expect(status).toBe(404);
  });
});

describe("POST route body constraints", () => {
  it("doctor refuses a nonempty body with 400 before any doctor fetch", async () => {
    const { baseUrl } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.doctor}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("disconnect refuses a nonempty body with 400 before any credential unset", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.disconnect}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"not":"empty"}',
    });
    expect(response.status).toBe(400);
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });

  it("an oversized 300KB doctor body is 413 with zero doctor fetch and zero credential unset", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.doctor}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(300 * 1024),
    });
    expect(response.status).toBe(413);
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });

  it("an oversized multibyte disconnect body is 413 before any credential unset", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.disconnect}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "好".repeat(150 * 1024),
    });
    expect(response.status).toBe(413);
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });

  it("an oversized connect body is 413 and never reaches the control seam", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.connect}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(128 * 1024),
    });
    expect(response.status).toBe(413);
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });

  it("a malformed UTF-8 connect body is a fixed 400 before any key parse or store", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.connect}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    });
    expect(response.status).toBe(400);
    const value = await response.json().catch(() => undefined);
    expect(record(value).error).toBe("invalid UTF-8 request body");
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });

  it("a malformed UTF-8 doctor body is a fixed 400 before any doctor fetch or credential change", async () => {
    const { baseUrl, credentials } = await bootWeb();
    const response = await fetch(`${baseUrl}${CONTROL_ROUTES.doctor}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xe2, 0x28, 0xa1]),
    });
    expect(response.status).toBe(400);
    const value = await response.json().catch(() => undefined);
    expect(record(value).error).toBe("invalid UTF-8 request body");
    expect((await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY")))?.value).toBe(FAKE_KEY);
  });
});

describe("body accumulation boundary", () => {
  it("bounded accumulator retains at most the byte limit across many chunks", () => {
    const limit = 1024;
    const accumulator = createBodyAccumulator(limit);
    const chunk = Buffer.alloc(300, 0x61);
    for (let index = 0; index < 20; index += 1) {
      accumulator.accept(chunk);
    }
    expect(accumulator.overflowed).toBe(true);
    expect(Buffer.byteLength(accumulator.decode(), "utf8")).toBeLessThanOrEqual(limit);
  });

  it("a small body under the limit never overflows and decodes exactly once", () => {
    const accumulator = createBodyAccumulator(64);
    accumulator.accept(Buffer.from('{"key":"sk-a"}', "utf8"));
    expect(accumulator.overflowed).toBe(false);
    expect(accumulator.decode()).toBe('{"key":"sk-a"}');
  });

  it("multibyte UTF-8 content is bounded by bytes, not UTF-16 units", () => {
    const limit = 64;
    const accumulator = createBodyAccumulator(limit);
    const multibyte = Buffer.from("好".repeat(100), "utf8");
    expect(multibyte.byteLength).toBeGreaterThan(limit);
    accumulator.accept(multibyte);
    expect(accumulator.overflowed).toBe(true);
    expect(Buffer.byteLength(accumulator.decode(), "utf8")).toBeLessThanOrEqual(limit);
  });

  it("four exact-limit invalid bytes fail decoding instead of inflating to replacement characters", () => {
    const accumulator = createBodyAccumulator(4);
    accumulator.accept(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(accumulator.overflowed).toBe(false);
    expect(() => accumulator.decode()).toThrow();
  });

  it("invalid UTF-8 split across chunk boundaries fails decoding", () => {
    const accumulator = createBodyAccumulator(64);
    accumulator.accept(Buffer.from([0xe2]));
    accumulator.accept(Buffer.from([0x28, 0xa1]));
    expect(accumulator.overflowed).toBe(false);
    expect(() => accumulator.decode()).toThrow();
  });

  it("an incomplete trailing UTF-8 sequence fails decoding", () => {
    const accumulator = createBodyAccumulator(64);
    accumulator.accept(Buffer.from([0xe2, 0x82]));
    expect(accumulator.overflowed).toBe(false);
    expect(() => accumulator.decode()).toThrow();
  });

  it("a valid multibyte character split across chunks decodes exactly once", () => {
    const accumulator = createBodyAccumulator(64);
    const bytes = Buffer.from("好", "utf8");
    expect(bytes.byteLength).toBe(3);
    accumulator.accept(bytes.subarray(0, 1));
    accumulator.accept(bytes.subarray(1, 3));
    expect(accumulator.overflowed).toBe(false);
    expect(accumulator.decode()).toBe("好");
  });

  it("a valid decoded body re-encodes to no more bytes than were retained", () => {
    const accumulator = createBodyAccumulator(1024);
    const input = '{"key":"sk-好-好-好"}';
    accumulator.accept(Buffer.from(input, "utf8"));
    const decoded = accumulator.decode();
    expect(Buffer.byteLength(decoded, "utf8")).toBe(Buffer.byteLength(input, "utf8"));
    expect(Buffer.byteLength(decoded, "utf8")).toBeLessThanOrEqual(1024);
  });

});
