/**
 * Host command surface for the OpenCode Go provider.
 *
 * `runCommand` dispatches one action to its renderer; the renderers convert
 * control-seam outcomes into sanitized, deterministic output. The connect key
 * is read from the input stream (never argv, never echoed); unknown actions
 * and flags fail loudly with fixed categories. Exit codes map to
 * success/failure.
 */
import { PLUGIN_NAME } from "./contract.ts";
import {
  renderConnect,
  renderDisconnect,
  renderDoctor,
  renderMigrationApply,
  renderMigrationDryRun,
  renderStatus,
} from "./commands-render.ts";
import type { CommandIo, CommandSurface } from "./commands-render.ts";

export type { CommandIo, CommandSurface } from "./commands-render.ts";

export const COMMAND_ACTIONS = [
  "doctor",
  "status",
  "connect",
  "disconnect",
  "migration-dry-run",
  "migration-apply",
] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Stable help text rendered for `--help` and no arguments. */
export function commandHelp(): string {
  return [
    `Usage: ${PLUGIN_NAME} <action> [args]`,
    "",
    "  doctor                test connectivity with one authenticated GET /models",
    "  status                report sanitized configured/lifecycle facts (no network)",
    "  connect               (Host-only) store the API key through the running Harness Web card",
    "  disconnect            (Host-only) remove the DSH credential through the running Harness Web card",
    "  migration-dry-run <settings-file>             show the exact migration diff",
    "  migration-apply <settings-file> [--revision <hash>]  apply the migration",
    "",
  ].join("\n");
}

function isAction(value: string): value is CommandAction {
  return COMMAND_ACTIONS.some((action) => action === value);
}

/**
 * Run one command action against the control seam and render sanitized output.
 * @param argv - action plus its positional arguments.
 * @param surface - the control seam the action operates on.
 * @param io - output sink and stdin key reader.
 * @returns the process exit code (0 success, 1 failure).
 */
export async function runCommand(
  argv: readonly string[],
  surface: CommandSurface,
  io: CommandIo,
): Promise<number> {
  const rawAction = argv[0];
  if (rawAction === undefined || rawAction === "--help" || rawAction === "-h") {
    io.write(commandHelp());
    return 0;
  }
  if (!isAction(rawAction)) {
    io.write(`${PLUGIN_NAME}: expected one of: ${COMMAND_ACTIONS.join(", ")}; got an unknown action`);
    return 1;
  }
  const rest = argv.slice(1);
  try {
    switch (rawAction) {
      case "doctor":
        return renderDoctor(surface, rest, io);
      case "status":
        return renderStatus(surface, rest, io);
      case "connect":
        return renderConnect(surface, rest, io);
      case "disconnect":
        return renderDisconnect(surface, rest, io);
      case "migration-dry-run":
        return renderMigrationDryRun(surface, rest, io);
      case "migration-apply":
        return renderMigrationApply(surface, rest, io);
    }
  } catch {
    io.write(`${PLUGIN_NAME}: ${rawAction} failed`);
    return 1;
  }
}
