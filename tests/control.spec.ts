/**
 * Task 7 control-seam contract (red-first).
 *
 * The narrow `ProviderControl` seam is mounted by the plugin and serves Host
 * commands and the client Remote/API. Connect accepts a key ONLY through the
 * DSH credentials service and never stores it anywhere else; disconnect calls
 * `credentials.unset` only and never touches the route, the directory or the
 * default model; status reports configured plus lifecycle facts and makes no
 * network call; doctor issues one authenticated GET /models through the
 * injected seam. Every route/card/directory assertion runs against the real
 * Cordis host via the shared harness.
 */
import { describe, expect, it } from "vitest";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { boot, requireControl, requireCredentials, requireSettings } from "./helpers/context-harness.ts";
import { NS } from "../src/service.ts";
import type { SyncFetch, SyncResponse } from "../src/sync.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_KEY = "sk-control-fake-key-0123456789abcdef";
const DERIVED_LIVE_URL = "https://opencode.ai/zen/go/v1/models";

function liveResponse(status: number, payload: unknown): SyncResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** A fetch serving the derived live endpoint; any other URL throws before a socket. */
function liveOnlyFetch(): { readonly fetch: SyncFetch; readonly calls: readonly string[] } {
  const urls: string[] = [];
  const fetch: SyncFetch = (url) => {
    urls.push(url);
    if (url !== DERIVED_LIVE_URL) throw new Error(`test guard: unexpected control URL ${url}`);
    return Promise.resolve(liveResponse(200, { data: [{ id: "grok-4.5" }, { id: "gpt-5.6" }] }));
  };
  return { fetch, calls: urls };
}

/** A fail-closed guard that records every attempted URL before throwing. */
function recordingGuard(): { readonly fetch: SyncFetch; readonly calls: readonly string[] } {
  const urls: string[] = [];
  const fetch: SyncFetch = (url) => {
    urls.push(url);
    throw new Error(`test guard: unexpected network URL ${url}`);
  };
  return { fetch, calls: urls };
}

describe("connect", () => {
  it("stores the key only through the credentials service and enables configured status", async () => {
    const guard = recordingGuard();
    const services = await boot({ fetch: guard.fetch });
    const control = requireControl(services.ctx);
    const credentials = requireCredentials(services);
    try {
      const result = await control.connect(FAKE_KEY);
      expect(result).toEqual({ kind: "connected", ref: credentialRef("OPENCODE_GO_API_KEY") });
      const resolved = await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"));
      expect(resolved?.value).toBe(FAKE_KEY);
      expect((await control.status()).configured).toBe(true);
    } finally {
      await services.fiber.dispose();
    }
  });

  it("never places the key in settings, status, or the control result", async () => {
    const guard = recordingGuard();
    const services = await boot({ fetch: guard.fetch });
    const control = requireControl(services.ctx);
    const settings = requireSettings(services);
    try {
      await control.connect(FAKE_KEY);
      const status = await control.status();
      expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(settings.get(NS))).not.toContain(FAKE_KEY);
    } finally {
      await services.fiber.dispose();
    }
  });

  it("rejects a non-canonical key before any credential write", async () => {
    const services = await boot();
    const control = requireControl(services.ctx);
    const credentials = requireCredentials(services);
    try {
      const result = await control.connect(` ${FAKE_KEY} `);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") expect(result.code).toBe("INVALID_CREDENTIAL");
      const resolved = await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"));
      expect(resolved).toBeUndefined();
    } finally {
      await services.fiber.dispose();
    }
  });
});

describe("disconnect", () => {
  it("unsets only the credential and leaves the route, directory and settings intact", async () => {
    const services = await boot({ credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    const control = requireControl(services.ctx);
    const credentials = requireCredentials(services);
    const settings = requireSettings(services);
    try {
      const before = settings.get(NS);
      expect((await control.status()).configured).toBe(true);
      const result = await control.disconnect();
      expect(result).toEqual({ kind: "disconnected", ref: credentialRef("OPENCODE_GO_API_KEY") });
      expect(await credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"))).toBeUndefined();
      expect((await control.status()).configured).toBe(false);
      expect(services.llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
      expect(services.llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual(["opencode-go"]);
      expect(services.llm.listConfigurableProviders()[0]?.declared).toBe(false);
      expect(settings.get(NS)).toEqual(before);
    } finally {
      await services.fiber.dispose();
    }
  });

  it("is idempotent: disconnecting an unconfigured provider is a no-op unset", async () => {
    const services = await boot();
    const control = requireControl(services.ctx);
    try {
      expect((await control.disconnect()).kind).toBe("disconnected");
      expect((await control.disconnect()).kind).toBe("disconnected");
      expect((await control.status()).configured).toBe(false);
    } finally {
      await services.fiber.dispose();
    }
  });
});

describe("status", () => {
  it("reports only sanitized configured/lifecycle facts and never touches the network", async () => {
    // A fetch that NEVER settles: if status awaited network it could not
    // resolve at all. The lifecycle's background refresh hangs inside its own
    // single-flight (contained), while status resolves immediately.
    const hanging: SyncFetch = () => new Promise(() => undefined);
    const services = await boot({ fetch: hanging });
    const control = requireControl(services.ctx);
    try {
      const status = await control.status();
      expect(status.configured).toBe(false);
      expect(status.origin).toBe("embedded");
      expect(status.modelCount).toBeGreaterThan(0);
      expect(status.refreshedAt).toMatch(/T\d{2}:\d{2}:\d{2}/);
      expect(["ok", "failed", "none"]).toContain(status.lastAttempt.kind);
    } finally {
      await services.fiber.dispose();
    }
  });
});

describe("doctor via the control seam", () => {
  it("issues exactly one authenticated GET /models and reports the sanitized count", async () => {
    const live = liveOnlyFetch();
    const services = await boot({ fetch: live.fetch, credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    const control = requireControl(services.ctx);
    try {
      const outcome = await control.doctor();
      expect(outcome.kind).toBe("configured");
      if (outcome.kind === "configured") expect(outcome.liveModelCount).toBe(2);
      expect(live.calls).toEqual([DERIVED_LIVE_URL]);
    } finally {
      await services.fiber.dispose();
    }
  });

  it("reports unconfigured with zero fetches when no credential exists", async () => {
    const live = liveOnlyFetch();
    const services = await boot({ fetch: live.fetch });
    const control = requireControl(services.ctx);
    try {
      const outcome = await control.doctor();
      expect(outcome.kind).toBe("unconfigured");
      expect(live.calls).toHaveLength(0);
    } finally {
      await services.fiber.dispose();
    }
  });
});

describe("migration via the control seam", () => {
  it("exposes dry-run and apply on a temp settings fixture without touching real state", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-opencode-go-control-"));
    const path = join(home, "settings.yaml");
    writeFileSync(
      path,
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      baseURL: https://opencode.ai/zen/go/v1",
        "    keep:",
        "      baseURL: https://keep.example/v1",
        "",
      ].join("\n"),
      "utf8",
    );
    const services = await boot();
    const control = requireControl(services.ctx);
    try {
      const dry = await control.migration.dryRun(path);
      expect(dry.kind).toBe("would-remove");
      if (dry.kind !== "would-remove") return;
      const applied = await control.migration.apply(path, { expectedRevision: dry.revision });
      expect(applied.kind).toBe("applied");
      const again = await control.migration.apply(path);
      expect(again.kind).toBe("no-change");
    } finally {
      await services.fiber.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
