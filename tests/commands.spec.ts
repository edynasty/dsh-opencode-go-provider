/**
 * Task 7 Host command contract (red-first).
 *
 * `runCommand` renders each surface operation into sanitized, deterministic
 * output: doctor/status/connect/disconnect text and migration JSON receipts.
 * The fake key reaches only `surface.connect` through `io.readKey` and is
 * never echoed; exit codes map to success/failure; unknown actions and flags
 * fail loudly with fixed categories (never echoing argv). The standalone
 * surface honestly refuses mutating actions (the DSH credential store is not
 * writable outside the running Host), and the stdin line decoder strips
 * exactly one terminator — never trimming, so padded keys reach canonical
 * validation unchanged.
 */
import { describe, expect, it } from "vitest";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { runCommand } from "../src/commands.ts";
import type { CommandIo, CommandSurface } from "../src/commands.ts";
import { standaloneControl } from "../src/control.ts";
import type { ConnectResult, DisconnectResult } from "../src/control.ts";
import type { DoctorOutcome } from "../src/doctor.ts";
import { decodeLine } from "../src/line-input.ts";
import type { MigrationApply, MigrationDryRun } from "../src/migration.ts";
import type { StatusResult } from "../src/status.ts";

const FAKE_KEY = "sk-command-fake-key-0123456789abcdef";
const REF = credentialRef("OPENCODE_GO_API_KEY");

const OK_STATUS: StatusResult = {
  configured: true,
  origin: "embedded",
  modelCount: 24,
  refreshedAt: "2026-08-14T00:00:00.000Z",
  lastAttempt: { kind: "ok" },
  attemptsSucceeded: 1,
  attemptsFailed: 0,
};

const NO_STATUS: StatusResult = { ...OK_STATUS, configured: false, lastAttempt: { kind: "none" } };

const NO_TARGET_DRY_RUN: MigrationDryRun = {
  kind: "no-target",
  revision: "0".repeat(64),
  target: { namespace: "llm-pi-ai", provider: "opencode-go" },
};

const NO_CHANGE_APPLY: MigrationApply = { kind: "no-change", revision: "0".repeat(64) };

interface FakeSurface {
  readonly surface: CommandSurface;
  readonly connectCalls: readonly string[];
}

function fakeSurface(overrides: Partial<CommandSurface> = {}): FakeSurface {
  const connectCalls: string[] = [];
  const surface: CommandSurface = {
    connect: async (key) => {
      connectCalls.push(key);
      return { kind: "connected", ref: REF } satisfies ConnectResult;
    },
    status: async () => NO_STATUS,
    doctor: async () => ({ kind: "unconfigured" }) satisfies DoctorOutcome,
    disconnect: async () => ({ kind: "disconnected", ref: REF }) satisfies DisconnectResult,
    migration: {
      dryRun: async () => NO_TARGET_DRY_RUN,
      apply: async (_path, options) =>
        ({ kind: "no-change", revision: options?.expectedRevision ?? "0".repeat(64) }) satisfies MigrationApply,
    },
    ...overrides,
  };
  return { surface, connectCalls };
}

function makeIo(key: string | undefined): { readonly io: CommandIo; readonly lines: readonly string[] } {
  const lines: string[] = [];
  return {
    io: { write: (line) => lines.push(line), readKey: async () => key },
    lines,
  };
}

function joined(lines: readonly string[]): string {
  return lines.join("\n");
}

describe("decodeLine", () => {
  it("strips exactly one LF terminator and never trims", () => {
    expect(decodeLine("abc\n")).toBe("abc");
    expect(decodeLine("abc\r\n")).toBe("abc");
    expect(decodeLine("  abc  \n")).toBe("  abc  ");
  });

  it("treats an empty line as no key but spaces as data", () => {
    expect(decodeLine("\n")).toBeUndefined();
    expect(decodeLine("\r\n")).toBeUndefined();
    expect(decodeLine("")).toBeUndefined();
    expect(decodeLine("  \n")).toBe("  ");
  });

  it("keeps control-carrying keys byte-identical for canonical rejection", () => {
    expect(decodeLine("key\nwith\tcontrol\n")).toBe("key\nwith\tcontrol");
  });
});

describe("runCommand", () => {
  it("renders the configured doctor report with the sanitized live count", async () => {
    const { surface } = fakeSurface({
      doctor: async () =>
        ({ kind: "configured", liveModelCount: 2, observedAt: "2026-08-14T00:00:00.000Z", httpStatus: 200 }) satisfies DoctorOutcome,
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["doctor"], surface, io);
    expect(code).toBe(0);
    expect(joined(lines)).toContain("2 available models");
    expect(joined(lines)).not.toContain(FAKE_KEY);
  });

  it("renders the unconfigured doctor report with exit code 1", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["doctor"], surface, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("not configured");
  });

  it("renders a failed doctor with its stable code and fixed message, never the body", async () => {
    const { surface } = fakeSurface({
      doctor: async () =>
        ({ kind: "failed", code: "LIVE_HTTP_401", message: "the live /models source failed" }) satisfies DoctorOutcome,
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["doctor"], surface, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("LIVE_HTTP_401");
    expect(joined(lines)).toContain("the live /models source failed");
  });

  it("renders the sanitized status facts", async () => {
    const { surface } = fakeSurface({ status: async () => OK_STATUS });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["status"], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("configured: yes");
    expect(out).toContain("source: embedded");
    expect(out).toContain("models: 24");
    expect(out).toContain("2026-08-14T00:00:00.000Z");
    expect(out).toContain("last attempt: ok");
    expect(out).not.toContain(FAKE_KEY);
  });

  it("connect reads the key from the input stream and never echoes it", async () => {
    const { surface, connectCalls } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["connect"], surface, io);
    expect(code).toBe(0);
    expect(connectCalls).toEqual([FAKE_KEY]);
    expect(joined(lines)).not.toContain(FAKE_KEY);
    expect(joined(lines)).toContain("connected");
  });

  it("connect fails loudly when no key is provided", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(undefined);
    const code = await runCommand(["connect"], surface, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("no key was provided");
  });

  it("connect renders an invalid-key refusal without echoing the value", async () => {
    const { surface } = fakeSurface({
      connect: async () =>
        ({ kind: "invalid", code: "INVALID_CREDENTIAL", message: "the key was refused before storing" }) satisfies ConnectResult,
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["connect"], surface, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("refused");
    expect(joined(lines)).not.toContain(FAKE_KEY);
  });

  it("disconnect renders the removed reference only", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["disconnect"], surface, io);
    expect(code).toBe(0);
    expect(joined(lines)).toContain("OPENCODE_GO_API_KEY");
    expect(joined(lines)).not.toContain(FAKE_KEY);
  });

  it("migration-dry-run renders allowlisted facts only, never raw removed lines or key names", async () => {
    const secret = "sk-receipt-fake-secret-abcdef0123456789";
    const receipt: MigrationDryRun = {
      kind: "would-remove",
      revision: "ab".repeat(32),
      target: { namespace: "llm-pi-ai", provider: "opencode-go" },
      diff: { removedKeys: ["api", "apiKeyEnv", "baseURL"], removedLines: ["    opencode-go:", `      apiKey: ${secret}`] },
    };
    const { surface } = fakeSurface({
      migration: {
        dryRun: async () => receipt,
        apply: async () => NO_CHANGE_APPLY,
      },
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-dry-run", "/tmp/fake-settings.yaml"], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("would remove llm-pi-ai.providers.opencode-go");
    expect(out).toContain("ab".repeat(32));
    expect(out).toContain("removed key count: 3");
    expect(out).toContain("removed line count: 2");
    // Never the raw removed lines, never arbitrary values, never the removed key names.
    expect(out).not.toContain("opencode-go:");
    expect(out).not.toContain("apiKey:");
    expect(out).not.toContain("baseURL");
    expect(out).not.toContain("apiKeyEnv");
    expect(out).not.toContain(secret);
  });

  it("migration-dry-run never renders hostile removed key names", async () => {
    const pathLike = "/Users/evil/settings.yaml";
    const controlLike = "key\nwith\tcontrol";
    const secretKey = "sk-RAW-KEY-SENTINEL-0123456789abcdef";
    const receipt: MigrationDryRun = {
      kind: "would-remove",
      revision: "ab".repeat(32),
      target: { namespace: "llm-pi-ai", provider: "opencode-go" },
      diff: {
        removedKeys: [pathLike, controlLike, secretKey],
        removedLines: ["    opencode-go:"],
      },
    };
    const { surface } = fakeSurface({
      migration: {
        dryRun: async () => receipt,
        apply: async () => NO_CHANGE_APPLY,
      },
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-dry-run", "/tmp/fake-settings.yaml"], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("removed key count: 3");
    expect(out).toContain("removed line count: 1");
    expect(out).not.toContain("/Users/evil");
    expect(out).not.toContain("settings.yaml");
    expect(out).not.toContain("with\tcontrol");
    expect(out).not.toContain("RAW-KEY-SENTINEL");
  });

  it("migration-apply passes the --revision to the surface and renders allowlisted facts only", async () => {
    const revision = "cd".repeat(32);
    const { surface } = fakeSurface({
      migration: {
        dryRun: async () => NO_TARGET_DRY_RUN,
        apply: async (_path, options) => {
          expect(options?.expectedRevision).toBe(revision);
          return {
            kind: "applied",
            revision: "ef".repeat(32),
            backupPath: "/Users/evil/fake-settings.yaml.migration-2026-08-14T00-00-00.000Z.bak",
            removedKeys: ["api"],
          } satisfies MigrationApply;
        },
      },
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-apply", "/tmp/fake-settings.yaml", "--revision", revision], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("applied");
    expect(out).toContain("removed key count: 1");
    expect(out).not.toContain("api");
    expect(out).not.toContain("ef".repeat(32));
    // The absolute backup path never reaches the output.
    expect(out).not.toContain("/Users/evil");
    expect(out).not.toContain(".bak");
  });

  it("migration-apply never renders hostile removed key names", async () => {
    const pathLike = "/Users/evil/settings.yaml";
    const controlLike = "key\nwith\tcontrol";
    const secretKey = "sk-RAW-KEY-SENTINEL-0123456789abcdef";
    const { surface } = fakeSurface({
      migration: {
        dryRun: async () => NO_TARGET_DRY_RUN,
        apply: async () =>
          ({
            kind: "applied",
            revision: "ef".repeat(32),
            backupPath: "/Users/evil/fake-settings.yaml.migration-2026-08-14T00-00-00.000Z.bak",
            removedKeys: [pathLike, controlLike, secretKey],
          }) satisfies MigrationApply,
      },
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-apply", "/tmp/fake-settings.yaml"], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("applied");
    expect(out).toContain("removed key count: 3");
    expect(out).not.toContain("/Users/evil");
    expect(out).not.toContain("with\tcontrol");
    expect(out).not.toContain("RAW-KEY-SENTINEL");
  });

  it("migration-apply renders a conflict without echoing either revision", async () => {
    const { surface } = fakeSurface({
      migration: {
        dryRun: async () => NO_TARGET_DRY_RUN,
        apply: async () => ({
          kind: "conflict",
          expected: "ab".repeat(32),
          actual: "cd".repeat(32),
        }) satisfies MigrationApply,
      },
    });
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-apply", "/tmp/fake-settings.yaml"], surface, io);
    expect(code).toBe(1);
    const out = joined(lines);
    expect(out).toContain("conflict");
    expect(out).not.toContain("ab".repeat(32));
    expect(out).not.toContain("cd".repeat(32));
  });

  it("migration-apply rejects a non-hex --revision with a fixed category and never echoes it", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const sentinel = "RAW-SECRET-SENTINEL-123456789";
    const code = await runCommand(["migration-apply", "/tmp/fake-settings.yaml", "--revision", sentinel], surface, io);
    expect(code).toBe(1);
    const out = joined(lines);
    expect(out).toContain("invalid revision");
    expect(out).not.toContain(sentinel);
    expect(out).not.toContain("RAW-SECRET");
  });

  it("help text states that standalone connect/disconnect are Host-only", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["--help"], surface, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("connect");
    expect(out).toContain("Host");
    expect(out).not.toContain("store the API key through DSH credentials");
  });

  it("rejects an unknown action with a fixed category, never echoing the input", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["sk-explode-fake-secret-0123456789"], surface, io);
    expect(code).toBe(1);
    const out = joined(lines);
    expect(out).toContain("expected one of: doctor, status, connect, disconnect, migration-dry-run, migration-apply");
    expect(out).not.toContain("sk-explode-fake-secret-0123456789");
  });

  it("rejects an unknown flag for a known action", async () => {
    const { surface } = fakeSurface();
    const { io } = makeIo(FAKE_KEY);
    const code = await runCommand(["doctor", "--bogus"], surface, io);
    expect(code).toBe(1);
  });

  it("migration-apply rejects an unknown option without echoing it", async () => {
    const { surface } = fakeSurface();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["migration-apply", "--sk-fake-option-0123456789", "/tmp/x.yaml"], surface, io);
    expect(code).toBe(1);
    expect(joined(lines)).not.toContain("sk-fake-option-0123456789");
  });
});

describe("standalone surface honesty", () => {
  it("connect on the standalone surface refuses because the store is not writable", async () => {
    const control = standaloneControl();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["connect"], control, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("not writable");
    expect(joined(lines)).not.toContain(FAKE_KEY);
  });

  it("disconnect on the standalone surface refuses because the store is not writable", async () => {
    const control = standaloneControl();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["disconnect"], control, io);
    expect(code).toBe(1);
    expect(joined(lines)).toContain("not writable");
  });

  it("status on the standalone surface reports environment facts without network", async () => {
    const control = standaloneControl();
    const { io, lines } = makeIo(FAKE_KEY);
    const code = await runCommand(["status"], control, io);
    expect(code).toBe(0);
    const out = joined(lines);
    expect(out).toContain("source: embedded");
    expect(out).toContain("models:");
  });
});
