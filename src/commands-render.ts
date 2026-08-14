/**
 * Per-action renderers for the OpenCode Go Host commands.
 *
 * Every renderer converts one control-seam outcome into sanitized,
 * deterministic text: doctor/status/connect/disconnect lines and migration
 * JSON receipts. All output is re-redacted for key-shaped tokens as a
 * belt-and-suspenders guard; argument parsing validates flag shapes and never
 * echoes raw argv back.
 */
import { PLUGIN_NAME } from "./contract.ts";
import type { ConnectResult, DisconnectResult } from "./control.ts";
import type { DoctorOutcome } from "./doctor.ts";
import { assertNever } from "./guards.ts";
import type { MigrationApply, MigrationApplyOptions, MigrationDryRun } from "./migration.ts";
import type { StatusResult } from "./status.ts";

export interface CommandIo {
  readonly write: (line: string) => void;
  readonly readKey: () => Promise<string | undefined>;
}

export interface CommandSurface {
  connect(key: string): Promise<ConnectResult>;
  status(): Promise<StatusResult>;
  doctor(signal?: AbortSignal): Promise<DoctorOutcome>;
  disconnect(): Promise<DisconnectResult>;
  migration: {
    dryRun(path: string): Promise<MigrationDryRun>;
    apply(path: string, options?: MigrationApplyOptions): Promise<MigrationApply>;
  };
}

export async function renderDoctor(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  if (rest.length > 0) {
    io.write(`${PLUGIN_NAME} doctor: accepts no options`);
    return 1;
  }
  const outcome = await surface.doctor();
  switch (outcome.kind) {
    case "configured":
      io.write(`OpenCode Go: connected; live /models reports ${outcome.liveModelCount} available models (observed at ${outcome.observedAt})`);
      return 0;
    case "unconfigured":
      io.write("OpenCode Go doctor: not configured; set OPENCODE_GO_API_KEY through the credentials service");
      return 1;
    case "unavailable":
      io.write("OpenCode Go doctor: unavailable; no usable live endpoint in the current catalog");
      return 1;
    case "failed":
      io.write(`OpenCode Go doctor: ${outcome.code}; ${outcome.message}`);
      return 1;
    default:
      return assertNever(outcome);
  }
}

export async function renderStatus(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  if (rest.length > 0) {
    io.write(`${PLUGIN_NAME} status: accepts no options`);
    return 1;
  }
  const status = await surface.status();
  const attempt =
    status.lastAttempt.kind === "ok"
      ? "ok"
      : status.lastAttempt.kind === "failed"
        ? `failed(${status.lastAttempt.code})`
        : "none";
  io.write("OpenCode Go status:");
  io.write(`  configured: ${status.configured ? "yes" : "no"}`);
  io.write(`  source: ${status.origin}`);
  io.write(`  models: ${status.modelCount}`);
  io.write(`  last refresh: ${status.refreshedAt}`);
  io.write(`  last attempt: ${attempt}`);
  io.write(`  refresh ok: ${status.attemptsSucceeded}`);
  io.write(`  refresh failed: ${status.attemptsFailed}`);
  return 0;
}

export async function renderConnect(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  if (rest.length > 0) {
    io.write(`${PLUGIN_NAME} connect: reads the key from stdin and accepts no options`);
    return 1;
  }
  const key = await io.readKey();
  if (key === undefined) {
    io.write(`${PLUGIN_NAME} connect: no key was provided`);
    return 1;
  }
  const result = await surface.connect(key);
  switch (result.kind) {
    case "connected":
      io.write(`OpenCode Go: connected; credential stored as ${result.ref}`);
      return 0;
    case "invalid":
      io.write(`OpenCode Go connect: ${result.message}`);
      return 1;
    case "store-failed":
      io.write(`OpenCode Go connect: ${result.message}`);
      return 1;
    default:
      return assertNever(result);
  }
}

export async function renderDisconnect(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  if (rest.length > 0) {
    io.write(`${PLUGIN_NAME} disconnect: accepts no options`);
    return 1;
  }
  const result = await surface.disconnect();
  switch (result.kind) {
    case "disconnected":
      io.write(`OpenCode Go: disconnected; removed ${result.ref}`);
      return 0;
    case "store-failed":
      io.write(`OpenCode Go disconnect: ${result.message}`);
      return 1;
    default:
      return assertNever(result);
  }
}

/** Allowlisted dry-run facts: target path names, the 64-hex revision, and the removed key/line COUNTS — never raw removed key names, lines or values. */
function dryRunText(receipt: MigrationDryRun): string {
  switch (receipt.kind) {
    case "would-remove":
      return [
        `would remove ${receipt.target.namespace}.providers.${receipt.target.provider}`,
        `revision ${receipt.revision}`,
        `removed key count: ${receipt.diff.removedKeys.length}`,
        `removed line count: ${receipt.diff.removedLines.length}`,
      ].join("; ");
    case "no-target":
      return `no legacy route found; revision ${receipt.revision}`;
    case "aborted":
      return `aborted: ${receipt.reason}`;
  }
}

/** Allowlisted apply facts: fixed kind plus the removed key count. */
function applyText(receipt: MigrationApply): string {
  switch (receipt.kind) {
    case "applied":
      return `applied; removed key count: ${receipt.removedKeys.length}`;
    case "no-change":
      return "no-change; nothing to migrate";
    case "conflict":
      return "conflict; the settings file changed during the migration";
    case "aborted":
      return `aborted: ${receipt.reason}`;
  }
}

/** A migration revision is exactly 64 hex characters (either case). */
function isValidRevision(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

export async function renderMigrationDryRun(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  const path = singlePathArgument("migration-dry-run", rest, io);
  if (path === undefined) return 1;
  const receipt = await surface.migration.dryRun(path);
  io.write(dryRunText(receipt));
  return receipt.kind === "aborted" ? 1 : 0;
}

export async function renderMigrationApply(
  surface: CommandSurface,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  let expectedRevision: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === "--revision") {
      const value = rest[index + 1];
      if (value === undefined) {
        io.write(`${PLUGIN_NAME} migration-apply: --revision requires a hash value`);
        return 1;
      }
      if (!isValidRevision(value)) {
        io.write(`${PLUGIN_NAME} migration-apply: invalid revision (expected 64 hex characters)`);
        return 1;
      }
      expectedRevision = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      io.write(`${PLUGIN_NAME} migration-apply: unknown option`);
      return 1;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    io.write(`${PLUGIN_NAME} migration-apply: expected exactly one settings-file path`);
    return 1;
  }
  const path = positional[0];
  if (path === undefined) {
    io.write(`${PLUGIN_NAME} migration-apply: expected exactly one settings-file path`);
    return 1;
  }
  const receipt = await surface.migration.apply(path, {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
  io.write(applyText(receipt));
  switch (receipt.kind) {
    case "applied":
    case "no-change":
      return 0;
    case "conflict":
    case "aborted":
      return 1;
    default:
      return assertNever(receipt);
  }
}

/** Parse exactly one positional settings-file path; never echoes the value. */
function singlePathArgument(
  action: string,
  rest: readonly string[],
  io: CommandIo,
): string | undefined {
  if (rest.length !== 1) {
    io.write(`${PLUGIN_NAME} ${action}: expected exactly one settings-file path`);
    return undefined;
  }
  const path = rest[0];
  if (path === undefined || path.length === 0) {
    io.write(`${PLUGIN_NAME} ${action}: expected exactly one settings-file path`);
    return undefined;
  }
  return path;
}
