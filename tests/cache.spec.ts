/**
 * Task 6 cache envelope specs (red-first).
 *
 * The runtime cache (`$DSH_HOME/cache/dsh-opencode-go-provider/catalog.json`)
 * is a versioned, strict envelope carrying exactly the reconciliation state
 * needed to continue the 14-day deprecation semantics offline. Parse-don't-
 * validate: unknown versions, unknown fields, truncation, non-canonical or
 * out-of-range timestamps, duplicate/unsorted ids, unsafe URLs and
 * inconsistent deprecation/quarantine state are all rejected — a bad cache is
 * never trusted and never deleted (the lifecycle falls back to embedded).
 * Writes are atomic temp+fsync+rename with private permissions; no temp files
 * survive a failure.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import {
  CACHE_ENVELOPE_VERSION,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  CacheError,
  renderCacheEnvelope,
  resolveCachePath,
  writeCacheAtomic,
} from "../src/cache.ts";
import { readCache } from "../src/cache-parse.ts";
import type { CatalogCacheEnvelope } from "../src/cache.ts";
import { FOURTEEN_DAYS_MS } from "../src/constants.ts";
import { parseJsonFile, parseModelsManifest } from "../src/state-file.ts";
import type { CatalogModel, DeprecatedEntry, QuarantineRecord } from "../src/types.ts";
import { readRepoFile } from "./helpers/catalog-fixtures.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");

/** The committed embedded catalog models (ascending id, validated shape). */
function catalogModels(): readonly CatalogModel[] {
  return parseModelsManifest(parseJsonFile(readRepoFile("catalog/models.json"), "models.json")).models;
}

/** A structurally valid cache envelope the tests mutate per case. */
function makeEnvelope(): CatalogCacheEnvelope {
  return {
    version: CACHE_ENVELOPE_VERSION,
    refreshedAt: T0.toISOString(),
    generatedAt: T0.toISOString(),
    sources: { modelsDevAt: T0.toISOString(), liveAt: T0.toISOString() },
    catalog: catalogModels(),
    deprecated: [],
    quarantine: [],
  };
}

/** A valid deprecated grace entry for one model. */
function deprecatedFor(model: CatalogModel): DeprecatedEntry {
  return { id: model.id, deprecatedAt: T0.toISOString(), model };
}

/** A valid quarantine record for one model id. */
function quarantineFor(model: CatalogModel): QuarantineRecord {
  return { id: model.id, detectedAt: T0.toISOString(), source: "live", reasonCode: "NO_MODELS_DEV_METADATA" };
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-cache-"));
}

/** Write raw (possibly malformed) cache bytes, creating the parent directory first. */
async function writeRaw(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("readCache envelope validation", () => {
  it("round-trips a valid envelope written atomically", async () => {
    // Given: a valid envelope and a fresh home directory.
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const envelope = makeEnvelope();
      // When: the envelope is written atomically then read back.
      await writeCacheAtomic(path, envelope);
      const parsed = readCache(path, new Date(T0.getTime() + 60_000));
      // Then: the parsed envelope is structurally identical.
      expect(parsed).toEqual(envelope);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns undefined when no cache file exists", async () => {
    const home = await tempHome();
    try {
      expect(readCache(resolveCachePath(home), T0)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported envelope version", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const { version: _version, ...rest } = makeEnvelope();
      void _version;
      await writeRaw(path, JSON.stringify({ version: 2, ...rest }));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level fields", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify({ ...makeEnvelope(), extra: true }));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects truncated or invalid JSON", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      await writeRaw(path, '{"version": 1, "catalog": [');
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a non-canonical refreshedAt", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const invalid = { ...makeEnvelope(), refreshedAt: "not-a-date" };
      await writeRaw(path, JSON.stringify(invalid));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a refreshedAt beyond the future-timestamp tolerance", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const future = { ...makeEnvelope(), refreshedAt: new Date(T0.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS + 1).toISOString() };
      await writeRaw(path, JSON.stringify(future));
      // When: read with the clock at T0 (the cache claims to be from the future).
      expect(() => readCache(path, T0)).toThrow(CacheError);
      // And a timestamp exactly at the tolerance is accepted, with sources
      // stamped at the same instant (the one-observation-instant invariant).
      const edgeIso = new Date(T0.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS).toISOString();
      const edge = { ...makeEnvelope(), refreshedAt: edgeIso, sources: { modelsDevAt: edgeIso, liveAt: edgeIso } };
      await writeRaw(path, JSON.stringify(edge));
      expect(() => readCache(path, T0)).not.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects duplicate catalog model ids", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      const second = models[1];
      if (first === undefined || second === undefined) throw new Error("test setup: catalog has no models");
      const duplicate = { ...makeEnvelope(), catalog: [first, first] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(duplicate));
      expect(() => readCache(path, T0)).toThrow(CacheError);
      void second;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unsorted catalog model ids", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      const second = models[1];
      if (first === undefined || second === undefined) throw new Error("test setup: catalog has no models");
      const reversed = { ...makeEnvelope(), catalog: [second, first] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(reversed));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a catalog model with an unsafe base URL", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const unsafe = { ...makeEnvelope(), catalog: [{ ...first, baseUrl: "http://evil.example/v1" }] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(unsafe));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a non-evicted deprecated entry whose id is missing from the catalog", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      const second = models[1];
      if (first === undefined || second === undefined) throw new Error("test setup: catalog has no models");
      const envelope = { ...makeEnvelope(), catalog: [second], deprecated: [deprecatedFor(first)] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an evicted deprecated entry whose id is still in the catalog", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const evicted: DeprecatedEntry = {
        id: first.id,
        deprecatedAt: T0.toISOString(),
        evictedAt: new Date(T0.getTime() + FOURTEEN_DAYS_MS + 1).toISOString(),
        model: first,
      };
      const envelope = { ...makeEnvelope(), deprecated: [evicted] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a quarantine id that is also a catalog model", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const envelope = { ...makeEnvelope(), quarantine: [quarantineFor(first)] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("never deletes a malformed cache file", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const broken = '{"version": 1, "catalog": [broken';
      await writeRaw(path, broken);
      expect(() => readCache(path, T0)).toThrow(CacheError);
      // Then: the file is still present with its original bytes.
      expect(readFileSync(path, "utf8")).toBe(broken);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("writeCacheAtomic", () => {
  it("creates parent directories and writes the rendered envelope", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      const envelope = makeEnvelope();
      await writeCacheAtomic(path, envelope);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(renderCacheEnvelope(envelope));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renders deterministically: re-rendering produces identical bytes", async () => {
    const envelope = makeEnvelope();
    expect(renderCacheEnvelope(envelope)).toBe(renderCacheEnvelope(envelope));
  });

  it("leaves no temp files after a successful write", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      await writeCacheAtomic(path, makeEnvelope());
      const names = await readdir(join(home, "cache", "dsh-opencode-go-provider"));
      expect(names).toEqual(["catalog.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses private file permissions on POSIX", async () => {
    if (process.platform === "win32") return;
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      await writeCacheAtomic(path, makeEnvelope());
      const { mode } = await import("node:fs/promises").then((m) => m.stat(path));
      // 0o600 → only owner read/write (mask ignores umask bits).
      expect(mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the target path is a directory and leaves no temp files", async () => {
    const home = await tempHome();
    try {
      const path = resolveCachePath(home);
      await mkdir(path, { recursive: true });
      await expect(writeCacheAtomic(path, makeEnvelope())).rejects.toThrow();
      const names = await readdir(join(home, "cache", "dsh-opencode-go-provider"));
      expect(names).toEqual(["catalog.json"]);
      expect(names.some((name) => name.includes(".tmp"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a parent mkdir failure yields a fixed code-fact CacheError without the path", async () => {
    const home = await tempHome();
    try {
      // A regular file in the way makes the recursive parent mkdir fail.
      const blocker = join(home, "blocker");
      await writeFile(blocker, "x", "utf8");
      const path = join(blocker, "cache", "dsh-opencode-go-provider", "catalog.json");
      await expect(writeCacheAtomic(path, makeEnvelope())).rejects.toThrow(CacheError);
      try {
        await writeCacheAtomic(path, makeEnvelope());
        throw new Error("expected rejection");
      } catch (error) {
        const message = String(error);
        expect(message).toMatch(/atomic write failed/);
        expect(message).not.toContain(blocker);
        expect(message).not.toContain(home);
        expect(message).not.toContain("/Users/");
        expect(message).not.toContain("mkdir");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("strict nested and timestamp validation", () => {
  const future = new Date(T0.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS + 1).toISOString();
  const soon = new Date(T0.getTime() + 60_000).toISOString();

  async function expectRejected(home: string, envelope: CatalogCacheEnvelope, expected?: RegExp): Promise<void> {
    const path = resolveCachePath(home);
    await writeRaw(path, JSON.stringify(envelope));
    const action = (): unknown => readCache(path, T0);
    if (expected !== undefined) {
      expect(action).toThrow(expected);
    } else {
      expect(action).toThrow(CacheError);
    }
  }

  it("rejects unknown keys inside sources", async () => {
    const home = await tempHome();
    try {
      const envelope = {
        ...makeEnvelope(),
        sources: { modelsDevAt: T0.toISOString(), liveAt: T0.toISOString(), authorization: "Bearer sk-leak" },
      };
      await expectRejected(home, envelope);
      // The malformed bytes are preserved, never deleted.
      expect(readFileSync(resolveCachePath(home), "utf8")).toContain("Bearer sk-leak");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a future generatedAt", async () => {
    const home = await tempHome();
    try {
      await expectRejected(home, { ...makeEnvelope(), generatedAt: future });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["modelsDevAt", "liveAt"] as const)("rejects a future sources.%s", async (key) => {
    const home = await tempHome();
    try {
      const sources = { ...makeEnvelope().sources, [key]: future };
      await expectRejected(home, { ...makeEnvelope(), sources });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a future deprecatedAt", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const deprecated = [{ ...deprecatedFor(first), deprecatedAt: future }];
      await expectRejected(home, { ...makeEnvelope(), deprecated });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a future evictedAt", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const deprecated = [{
        id: first.id,
        deprecatedAt: T0.toISOString(),
        evictedAt: new Date(T0.getTime() + FOURTEEN_DAYS_MS + 1).toISOString(),
        model: first,
      }];
      await expectRejected(home, { ...makeEnvelope(), deprecated });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a future quarantine detectedAt", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const quarantine = [{ ...quarantineFor(first), detectedAt: future }];
      await expectRejected(home, { ...makeEnvelope(), quarantine });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a generatedAt after refreshedAt", async () => {
    const home = await tempHome();
    try {
      // `soon` is within the future tolerance but still after refreshedAt (T0).
      await expectRejected(home, { ...makeEnvelope(), generatedAt: soon });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["modelsDevAt", "liveAt"] as const)("rejects a sources.%s after refreshedAt", async (key) => {
    const home = await tempHome();
    try {
      const sources = { ...makeEnvelope().sources, [key]: soon };
      await expectRejected(home, { ...makeEnvelope(), sources });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a deprecatedAt after refreshedAt", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const deprecated = [{ ...deprecatedFor(first), deprecatedAt: soon }];
      await expectRejected(home, { ...makeEnvelope(), deprecated });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a quarantine detectedAt after refreshedAt", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const quarantine = [{ ...quarantineFor(first), detectedAt: soon }];
      await expectRejected(home, { ...makeEnvelope(), quarantine });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("accepts a preserved generatedAt older than refreshedAt", async () => {
    const home = await tempHome();
    try {
      const envelope = { ...makeEnvelope(), generatedAt: new Date(T0.getTime() - 86_400_000).toISOString() };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).not.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a malformed deprecated entry never echoes its id or raw body text", async () => {
    const home = await tempHome();
    try {
      const maliciousId = "sk-literal-leak-abcdef";
      const envelope = {
        ...makeEnvelope(),
        deprecated: [{ id: maliciousId, deprecatedAt: T0.toISOString(), evictedAt: "bad", model: {} }],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        const message = String(error);
        expect(message).toMatch(/deprecated state is malformed/);
        expect(message).not.toContain(maliciousId);
        expect(message).not.toContain("evictedAt");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown nested fields in a catalog model", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const envelope = { ...makeEnvelope(), catalog: [{ ...first, authorization: "Bearer sk-leak" }] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown nested fields inside cost and tiers", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const withSecretCost = {
        ...makeEnvelope(),
        catalog: [{ ...first, cost: { ...first.cost, secret: "sk-leak" } }],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(withSecretCost));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown nested fields inside reasoningOptions and interleaved", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const withSecretOptions = {
        ...makeEnvelope(),
        catalog: [{ ...first, reasoningOptions: [{ kind: "effort", values: ["low"], extra: true }], interleaved: { field: "x", secret: 1 } }],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(withSecretOptions));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown nested fields inside deprecated entries and their models", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const envelope = {
        ...makeEnvelope(),
        deprecated: [{ ...deprecatedFor(first), extra: true, model: { ...first, authorization: "Bearer sk-leak" } }],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown nested fields inside quarantine entries", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const envelope = { ...makeEnvelope(), quarantine: [{ ...quarantineFor(first), extra: true }] };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects descending deprecated ids", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      const second = models[1];
      if (first === undefined || second === undefined) throw new Error("test setup: catalog has no models");
      const envelope = {
        ...makeEnvelope(),
        deprecated: [deprecatedFor(second), deprecatedFor(first)],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects descending quarantine ids", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      const second = models[1];
      if (first === undefined || second === undefined) throw new Error("test setup: catalog has no models");
      const envelope = {
        ...makeEnvelope(),
        quarantine: [quarantineFor(second), quarantineFor(first)],
      };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(envelope));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects source timestamps that do not equal refreshedAt", async () => {
    const home = await tempHome();
    try {
      const soon = new Date(T0.getTime() + 60_000).toISOString();
      const mismatch = { ...makeEnvelope(), sources: { modelsDevAt: T0.toISOString(), liveAt: soon } };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify(mismatch));
      expect(() => readCache(path, T0)).toThrow(CacheError);
      const stale = { ...makeEnvelope(), sources: { modelsDevAt: new Date(T0.getTime() - 60_000).toISOString(), liveAt: T0.toISOString() } };
      await writeRaw(path, JSON.stringify(stale));
      expect(() => readCache(path, T0)).toThrow(CacheError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("an unknown malicious field name never appears in CacheError text", async () => {
    const home = await tempHome();
    try {
      const malicious = "sk-field-name-secret-abcdef";
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify({ ...makeEnvelope(), [malicious]: true }));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error instanceof CacheError).toBe(true);
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a malicious version value never appears in CacheError text", async () => {
    const home = await tempHome();
    try {
      const malicious = "sk-version-secret-123456";
      const { version: _version, ...rest } = makeEnvelope();
      void _version;
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify({ ...rest, version: malicious }));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error instanceof CacheError).toBe(true);
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("duplicate and unordered catalog ids never appear in CacheError text", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const malicious = "sk-id-secret-abcdef-987654";
      const dup = { ...first, id: malicious };
      const path = resolveCachePath(home);
      await writeRaw(path, JSON.stringify({ ...makeEnvelope(), catalog: [dup, dup] }));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
      // Descending ids with key-shaped ids must stay generic too.
      const second = models[1];
      if (second === undefined) throw new Error("test setup: catalog has no models");
      const depB = deprecatedFor({ ...second, id: `${malicious}-b` });
      const depA = deprecatedFor({ ...first, id: `${malicious}-a` });
      await writeRaw(path, JSON.stringify({ ...makeEnvelope(), deprecated: [depB, depA] }));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("timestamp and coherence ids never appear in CacheError text", async () => {
    const home = await tempHome();
    try {
      const models = catalogModels();
      const first = models[0];
      if (first === undefined) throw new Error("test setup: catalog has no models");
      const malicious = "sk-id-secret-abcdef-987654";
      const path = resolveCachePath(home);
      const future = new Date(T0.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS + 1).toISOString();
      // Future deprecatedAt with a key-shaped id.
      const withFuture = {
        ...makeEnvelope(),
        deprecated: [{ ...deprecatedFor({ ...first, id: malicious }), deprecatedAt: future }],
      };
      await writeRaw(path, JSON.stringify(withFuture));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
      // Quarantine/catalog overlap with a key-shaped id.
      const overlap = {
        ...makeEnvelope(),
        catalog: [{ ...first, id: malicious }],
        quarantine: [quarantineFor({ ...first, id: malicious })],
      };
      await writeRaw(path, JSON.stringify(overlap));
      try {
        readCache(path, T0);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain(malicious);
        expect(String(error)).not.toContain("sk-");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("filesystem error codes are validated against a safe pattern before interpolation", async () => {
    const { sanitizeFsErrorCode } = await import("../src/cache.ts");
    expect(sanitizeFsErrorCode("ENOTDIR")).toBe("ENOTDIR");
    expect(sanitizeFsErrorCode("EACCES")).toBe("EACCES");
    expect(sanitizeFsErrorCode("sk-code-secret-123456")).toBe("UNKNOWN");
    expect(sanitizeFsErrorCode("")).toBe("UNKNOWN");
    expect(sanitizeFsErrorCode(undefined)).toBe("UNKNOWN");
  });
});

describe("resolveCachePath", () => {
  it("resolves under $DSH_HOME/cache/dsh-opencode-go-provider/catalog.json", () => {
    expect(resolveCachePath("/tmp/fake-dsh-home")).toBe(
      "/tmp/fake-dsh-home/cache/dsh-opencode-go-provider/catalog.json",
    );
  });
});
