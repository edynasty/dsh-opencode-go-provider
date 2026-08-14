/**
 * Task 4 config contract tests (red-first).
 *
 * The schemastery `Config` schema owns per-field interval validation; the
 * `assertServiceable` hook owns unknown-key rejection (schemastery's object
 * merge keeps unknown keys, so the hook is the only refusal point) and the
 * cross-field invariants; `resolveConfig` detaches and freezes the per-operation
 * snapshot. No natural-language assertions; all expectations are machine values.
 */
import { describe, expect, it } from "vitest";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { Config, DEFAULTS, assertServiceable, resolveConfig } from "../src/config.ts";

const DEFAULT_SNAPSHOT = {
  apiKeyEnv: "OPENCODE_GO_API_KEY",
  refreshMs: 3_600_000,
  freshnessMs: 300_000,
  timeoutMs: 10_000,
  graceMs: 1_209_600_000,
};

describe("config defaults", () => {
  it("exposes the exact DEFAULTS constant", () => {
    expect(DEFAULTS).toEqual(DEFAULT_SNAPSHOT);
  });

  it("resolves the exact defaults from an empty section", () => {
    expect(Config({})).toEqual(DEFAULT_SNAPSHOT);
  });

  it("resolves a complete section through the schema", () => {
    const raw = Config({
      apiKeyEnv: "OPENCODE_GO_ALT_KEY",
      refreshMs: 1_800_000,
      freshnessMs: 120_000,
      timeoutMs: 5_000,
      graceMs: 604_800_000,
    });
    expect(raw).toEqual({
      apiKeyEnv: "OPENCODE_GO_ALT_KEY",
      refreshMs: 1_800_000,
      freshnessMs: 120_000,
      timeoutMs: 5_000,
      graceMs: 604_800_000,
    });
  });
});

describe("config interval rejection", () => {
  it.each(["refreshMs", "freshnessMs", "timeoutMs", "graceMs"] as const)(
    "rejects zero %s",
    (key) => {
      expect(() => Config({ [key]: 0 })).toThrow();
    },
  );

  it.each(["refreshMs", "freshnessMs", "timeoutMs", "graceMs"] as const)(
    "rejects negative %s",
    (key) => {
      expect(() => Config({ [key]: -1 })).toThrow();
    },
  );

  it.each(["refreshMs", "freshnessMs", "timeoutMs", "graceMs"] as const)(
    "rejects fractional %s",
    (key) => {
      expect(() => Config({ [key]: 1.5 })).toThrow();
    },
  );

  it.each(["refreshMs", "freshnessMs", "timeoutMs", "graceMs"] as const)(
    "rejects non-finite %s",
    (key) => {
      expect(() => Config({ [key]: Number.NaN })).toThrow();
      expect(() => Config({ [key]: Number.POSITIVE_INFINITY })).toThrow();
      expect(() => Config({ [key]: Number.NEGATIVE_INFINITY })).toThrow();
    },
  );

  it.each(["refreshMs", "freshnessMs", "timeoutMs", "graceMs"] as const)(
    "rejects over-timer-bound %s",
    (key) => {
      expect(() => Config({ [key]: MAX_TIMER_DELAY_MS + 1 })).toThrow();
    },
  );

  it("accepts the timer bound exactly", () => {
    expect(() => Config({ refreshMs: MAX_TIMER_DELAY_MS })).not.toThrow();
  });
});

describe("config unknown-key and literal-secret rejection", () => {
  it("rejects a literal apiKey field", () => {
    expect(() => assertServiceable(Config({ apiKey: "sk-fake-secret-value" }))).toThrow(
      /apiKey/,
    );
  });

  it("rejects a literal apiKeyLiteral field", () => {
    expect(() => assertServiceable(Config({ apiKeyLiteral: "sk-fake-secret-value" }))).toThrow(
      /apiKeyLiteral/,
    );
  });

  it("rejects an authorizationHeader field", () => {
    expect(() =>
      assertServiceable(Config({ authorizationHeader: "Bearer sk-fake-secret-value" })),
    ).toThrow(/authorizationHeader/);
  });

  it("rejects any unknown key", () => {
    expect(() => assertServiceable(Config({ surprise: 1 }))).toThrow(/surprise/);
  });

  it("accepts the declared key set", () => {
    expect(() => assertServiceable(Config({}))).not.toThrow();
  });
});

describe("config cross-field invariants", () => {
  it("rejects freshnessMs greater than refreshMs", () => {
    const raw = Config({ refreshMs: 60_000, freshnessMs: 120_000 });
    expect(() => assertServiceable(raw)).toThrow(/freshnessMs/);
  });

  it("accepts freshnessMs equal to refreshMs", () => {
    const raw = Config({ refreshMs: 60_000, freshnessMs: 60_000 });
    expect(() => assertServiceable(raw)).not.toThrow();
  });

  it("rejects timeoutMs greater than refreshMs", () => {
    const raw = Config({ refreshMs: 60_000, freshnessMs: 30_000, timeoutMs: 120_000 });
    expect(() => assertServiceable(raw)).toThrow(/timeoutMs/);
  });

  it("accepts timeoutMs equal to refreshMs", () => {
    const raw = Config({ refreshMs: 60_000, freshnessMs: 30_000, timeoutMs: 60_000 });
    expect(() => assertServiceable(raw)).not.toThrow();
  });
});

describe("config credential reference", () => {
  it("rejects a non-POSIX apiKeyEnv reference", () => {
    const raw = Config({ apiKeyEnv: "not-a-valid ref!" });
    expect(() => assertServiceable(raw)).toThrow();
  });

  it("rejects a whitespace-containing apiKeyEnv reference", () => {
    const raw = Config({ apiKeyEnv: "OPENCODE GO KEY" });
    expect(() => assertServiceable(raw)).toThrow();
  });
});

describe("resolveConfig snapshot", () => {
  it("brands apiKeyEnv into a validated credential reference", () => {
    const snapshot = resolveConfig(Config({ apiKeyEnv: "OPENCODE_GO_ALT_KEY" }));
    expect(snapshot.apiKeyEnv).toBe("OPENCODE_GO_ALT_KEY");
  });

  it("returns a detached snapshot unaffected by caller mutation", () => {
    const raw = Config({});
    const snapshot = resolveConfig(raw);
    raw.refreshMs = 999_999;
    expect(snapshot.refreshMs).toBe(DEFAULT_SNAPSHOT.refreshMs);
  });

  it("freezes the snapshot", () => {
    const snapshot = resolveConfig(Config({}));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
