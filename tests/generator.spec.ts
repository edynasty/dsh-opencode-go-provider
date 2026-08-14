/**
 * Generator core specs (Task 3 remediation).
 *
 * Bootstrap mode derives the embedded catalog from public models.dev metadata
 * only — availability stays unverified, no quarantine/deprecated state is
 * fabricated. Live mode requires an explicit live ids payload and marks
 * availability verified. Network source loading fails closed without an API
 * key and never mixes fresh metadata with synthetic availability.
 */
import { describe, expect, it } from "vitest";
import { generateCatalogFiles } from "../src/generator.ts";
import { fetchNetworkSources } from "../scripts/sources.ts";
import { parseJsonFile, parseModelsManifest } from "../src/state-file.ts";
import { isRecord } from "../src/guards.ts";
import { readFixture, readRepoFile } from "./helpers/catalog-fixtures.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");
const DAY = 86_400_000;

function baseInput(overrides: Partial<Parameters<typeof generateCatalogFiles>[0]> = {}) {
  return {
    modelsDevJson: readFixture("models-dev-opencode-go.json"),
    patchesJson: readRepoFile("catalog/patches.json"),
    live: undefined,
    previousModelsJson: undefined,
    previousQuarantineJson: undefined,
    previousDeprecatedJson: undefined,
    now: T0,
    provenance: "test",
    ...overrides,
  };
}

describe("bootstrap mode (embedded product state)", () => {
  it("derives the catalog from metadata only and never fabricates availability", () => {
    // Given: the frozen models.dev metadata and no live observation.
    // When: the generator runs in bootstrap mode.
    const output = generateCatalogFiles(baseInput());
    // Then: all 24 metadata records are served with unverified availability
    // and no quarantine or deprecated state is invented.
    expect(output.stats.known).toBe(24);
    const manifest = parseModelsManifest(parseJsonFile(output.files["models.json"], "models.json"));
    expect(manifest.availability).toEqual({ kind: "unverified" });
    expect(manifest.models.some((m) => m.id === "synthetic-unknown-live-probe")).toBe(false);
    expect(output.files["quarantine.json"]).toBe("[]\n");
    expect(output.files["deprecated.json"]).toBe("[]\n");
  });

  it("is byte-identical on reruns even when the clock advances", () => {
    // Given: a first bootstrap run at T0.
    const first = generateCatalogFiles(baseInput());
    // When: rerun with the first output as state and a later clock.
    const second = generateCatalogFiles(
      baseInput({
        previousModelsJson: first.files["models.json"],
        previousQuarantineJson: first.files["quarantine.json"],
        previousDeprecatedJson: first.files["deprecated.json"],
        now: new Date(T0.getTime() + 3 * DAY),
      }),
    );
    // Then: every artifact is byte-identical and generatedAt is preserved.
    expect(second.files).toEqual(first.files);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.transitioned).toBe(false);
  });

  it("marks availability verified with the fixture source when live ids are supplied", () => {
    // Given: an explicit test fixture as the live ids source.
    // When: the generator runs in live mode.
    const output = generateCatalogFiles(
      baseInput({ live: { liveJson: readFixture("live-models.json"), source: "fixture" } }),
    );
    // Then: availability is verified-with-fixture and the synthetic probe is
    // quarantined exactly as before (test-only semantics).
    const manifest = parseModelsManifest(parseJsonFile(output.files["models.json"], "models.json"));
    expect(manifest.availability).toEqual({ kind: "verified", liveSource: "fixture" });
    expect(output.files["quarantine.json"]).toContain("synthetic-unknown-live-probe");
    expect(output.stats.quarantined).toBe(1);
  });
});

describe("network source loading", () => {
  const FULL_MAP = JSON.stringify({
    deepseek: { id: "deepseek", name: "DeepSeek", npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com", models: {} },
    "opencode-go": {
      id: "opencode-go",
      name: "OpenCode Go",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "deepseek-v4-flash": {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          limit: { context: 1_000_000, output: 384_000 },
        },
      },
    },
  });

  function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
    if (url === "https://models.opencode.ai/api.json") {
      return Promise.resolve(new Response(FULL_MAP, { status: 200 }));
    }
    if (url === "https://opencode.ai/zen/go/v1/models") {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      if (auth === null) return Promise.resolve(new Response("{}", { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }

  it("fails closed without an API key before any fetch", async () => {
    // Given: no OPENCODE_GO_API_KEY and a fetch spy.
    let calls = 0;
    const spy = (url: string, init?: RequestInit): Promise<Response> => {
      void url;
      void init;
      calls += 1;
      return Promise.resolve(new Response("", { status: 500 }));
    };
    // When: network sources are requested without a key.
    // Then: the promise rejects and no network call was made.
    await expect(fetchNetworkSources(undefined, spy)).rejects.toThrow(/OPENCODE_GO_API_KEY/);
    expect(calls).toBe(0);
  });

  it("rejects empty and whitespace-only API keys before any fetch", async () => {
    // Given: whitespace-only keys and a fetch spy.
    let calls = 0;
    const spy = (url: string, init?: RequestInit): Promise<Response> => {
      void url;
      void init;
      calls += 1;
      return Promise.resolve(new Response("", { status: 500 }));
    };
    // When: network sources are requested with unsafe keys.
    // Then: the promise rejects without any network call or secret echo.
    await expect(fetchNetworkSources("", spy)).rejects.toThrow(/OPENCODE_GO_API_KEY/);
    await expect(fetchNetworkSources("   ", spy)).rejects.toThrow(/OPENCODE_GO_API_KEY/);
    expect(calls).toBe(0);
  });

  it("parses the full provider map and returns the selected record for generation", async () => {
    // Given: an API key and the real full-map payload shape.
    // When: network sources are requested.
    const sources = await fetchNetworkSources("test-key", fakeFetch);
    // Then: modelsDevJson is the selected opencode-go provider RECORD (not the
    // full map), so generation can parse it as a single provider.
    const parsed: unknown = JSON.parse(sources.modelsDevJson);
    const record = isRecord(parsed) ? parsed : undefined;
    expect(record?.id).toBe("opencode-go");
    expect(sources.liveJson).toContain("deepseek-v4-flash");
  });

  it("feeds network sources straight into generation and produces a valid manifest", async () => {
    // Given: the full-map network payload and captured live ids.
    // When: the network output flows directly into generateCatalogFiles.
    const sources = await fetchNetworkSources("test-key", fakeFetch);
    const output = generateCatalogFiles({
      modelsDevJson: sources.modelsDevJson,
      patchesJson: readRepoFile("catalog/patches.json"),
      live: { liveJson: sources.liveJson, source: "live" },
      previousModelsJson: undefined,
      previousQuarantineJson: undefined,
      previousDeprecatedJson: undefined,
      now: T0,
      provenance: "network test",
    });
    // Then: a valid manifest is generated with the live-verified marker and
    // the captured model served under its real protocol.
    const manifest = parseModelsManifest(parseJsonFile(output.files["models.json"], "models.json"));
    expect(manifest.availability).toEqual({ kind: "verified", liveSource: "live" });
    expect(manifest.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
    expect(manifest.models[0]?.protocol).toBe("openai-completions");
    expect(output.transitioned).toBe(true);
  });

  it("never falls back to synthetic availability when the live capture fails", async () => {
    // Given: a live endpoint that returns 500.
    const failing = (url: string, init?: RequestInit): Promise<Response> => {
      void init;
      if (url === "https://models.opencode.ai/api.json") {
        return Promise.resolve(new Response(FULL_MAP, { status: 200 }));
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    };
    // When: network sources are requested.
    // Then: the promise rejects instead of mixing fresh metadata with a
    // synthetic/stale live fixture.
    await expect(fetchNetworkSources("test-key", failing)).rejects.toThrow(/HTTP 500/);
  });
});

describe("provenance transitions", () => {
  it("treats a provenance-only change as a real transition with a fresh generatedAt", () => {
    // Given: a first bootstrap run at T0 with provenance "v1".
    const first = generateCatalogFiles(baseInput({ provenance: "v1" }));
    // When: rerun with identical semantic inputs but provenance "v2".
    const second = generateCatalogFiles(
      baseInput({
        provenance: "v2",
        previousModelsJson: first.files["models.json"],
        previousQuarantineJson: first.files["quarantine.json"],
        previousDeprecatedJson: first.files["deprecated.json"],
        now: new Date(T0.getTime() + DAY),
      }),
    );
    // Then: the run transitions, generatedAt advances to the new clock, and
    // the artifact bytes change.
    expect(second.transitioned).toBe(true);
    expect(second.generatedAt).toBe(new Date(T0.getTime() + DAY).toISOString());
    expect(second.files["models.json"]).not.toBe(first.files["models.json"]);
    expect(second.files["models.json"]).toContain('"provenance": "v2"');
  });

  it("keeps identical provenance and state byte-stable across a later clock", () => {
    // Given: a first bootstrap run at T0 with provenance "v1".
    const first = generateCatalogFiles(baseInput({ provenance: "v1" }));
    // When: rerun with the same provenance and a later clock.
    const second = generateCatalogFiles(
      baseInput({
        provenance: "v1",
        previousModelsJson: first.files["models.json"],
        previousQuarantineJson: first.files["quarantine.json"],
        previousDeprecatedJson: first.files["deprecated.json"],
        now: new Date(T0.getTime() + 3 * DAY),
      }),
    );
    // Then: every artifact is byte-identical and generatedAt is preserved.
    expect(second.files).toEqual(first.files);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.transitioned).toBe(false);
  });
});

describe("credential endpoint and key invariants", () => {
  it("never sends credentials to a non-OpenCode-Go endpoint and leaks no key fragment", async () => {
    // Given: a malicious provider record whose api points at evil.example.com.
    const evilMap = JSON.stringify({
      "opencode-go": {
        id: "opencode-go",
        name: "OpenCode Go",
        npm: "@ai-sdk/openai-compatible",
        api: "http://evil.example.com/v1",
        models: {},
      },
    });
    let credentialRequests = 0;
    const spy = (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== null) credentialRequests += 1;
      if (url === "https://models.opencode.ai/api.json") {
        return Promise.resolve(new Response(evilMap, { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    };
    // When: network sources are requested with a key.
    const error = await fetchNetworkSources("test-key", spy).then(
      () => undefined,
      (cause: unknown) => String(cause),
    );
    // Then: the run fails closed, zero credential-bearing requests were made,
    // and the error message contains no fragment of the key.
    expect(error).toContain("OpenCode Go base URL");
    expect(error).not.toContain("test-key");
    expect(credentialRequests).toBe(0);
  });

  it("rejects every non-canonical API key with zero fetches and no secret echo", async () => {
    // Given: keys with empty, untrimmed, internal-whitespace, CR/LF or
    // control characters.
    const keys = ["", "   ", " key", "key ", "k ey", "key\n", "key\r", "k\u0000ey"];
    // When: network sources are requested with each key.
    for (const key of keys) {
      let calls = 0;
      const spy = (url: string, init?: RequestInit): Promise<Response> => {
        void url;
        void init;
        calls += 1;
        return Promise.resolve(new Response("", { status: 500 }));
      };
      const error = await fetchNetworkSources(key, spy).then(
        () => undefined,
        (cause: unknown) => String(cause),
      );
      // Then: every run fails before any network call and echoes no secret.
      expect(error).toContain("OPENCODE_GO_API_KEY");
      if (key.trim() !== "") {
        expect(error).not.toContain(key.trim());
      }
      expect(calls).toBe(0);
    }
  });
});
