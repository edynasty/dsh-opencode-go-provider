#!/usr/bin/env node
import { H as assertNever, X as PLUGIN_NAME, n as standaloneControl } from "./control-CZd1dUg_.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/commands-render.ts
/**
* Per-action renderers for the OpenCode Go Host commands.
*
* Every renderer converts one control-seam outcome into sanitized,
* deterministic text: doctor/status/connect/disconnect lines and migration
* JSON receipts. All output is re-redacted for key-shaped tokens as a
* belt-and-suspenders guard; argument parsing validates flag shapes and never
* echoes raw argv back.
*/
async function renderDoctor(surface, rest, io) {
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
		default: return assertNever(outcome);
	}
}
async function renderStatus(surface, rest, io) {
	if (rest.length > 0) {
		io.write(`${PLUGIN_NAME} status: accepts no options`);
		return 1;
	}
	const status = await surface.status();
	const attempt = status.lastAttempt.kind === "ok" ? "ok" : status.lastAttempt.kind === "failed" ? `failed(${status.lastAttempt.code})` : "none";
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
async function renderConnect(surface, rest, io) {
	if (rest.length > 0) {
		io.write(`${PLUGIN_NAME} connect: reads the key from stdin and accepts no options`);
		return 1;
	}
	const key = await io.readKey();
	if (key === void 0) {
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
		default: return assertNever(result);
	}
}
async function renderDisconnect(surface, rest, io) {
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
		default: return assertNever(result);
	}
}
/** Allowlisted dry-run facts: target path names, the 64-hex revision, and the removed key/line COUNTS — never raw removed key names, lines or values. */
function dryRunText(receipt) {
	switch (receipt.kind) {
		case "would-remove": return [
			`would remove ${receipt.target.namespace}.providers.${receipt.target.provider}`,
			`revision ${receipt.revision}`,
			`removed key count: ${receipt.diff.removedKeys.length}`,
			`removed line count: ${receipt.diff.removedLines.length}`
		].join("; ");
		case "no-target": return `no legacy route found; revision ${receipt.revision}`;
		case "aborted": return `aborted: ${receipt.reason}`;
	}
}
/** Allowlisted apply facts: fixed kind plus the removed key count. */
function applyText(receipt) {
	switch (receipt.kind) {
		case "applied": return `applied; removed key count: ${receipt.removedKeys.length}`;
		case "no-change": return "no-change; nothing to migrate";
		case "conflict": return "conflict; the settings file changed during the migration";
		case "aborted": return `aborted: ${receipt.reason}`;
	}
}
/** A migration revision is exactly 64 hex characters (either case). */
function isValidRevision(value) {
	return /^[0-9a-fA-F]{64}$/.test(value);
}
async function renderMigrationDryRun(surface, rest, io) {
	const path = singlePathArgument("migration-dry-run", rest, io);
	if (path === void 0) return 1;
	const receipt = await surface.migration.dryRun(path);
	io.write(dryRunText(receipt));
	return receipt.kind === "aborted" ? 1 : 0;
}
async function renderMigrationApply(surface, rest, io) {
	let expectedRevision;
	const positional = [];
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === void 0) continue;
		if (arg === "--revision") {
			const value = rest[index + 1];
			if (value === void 0) {
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
		} else positional.push(arg);
	}
	if (positional.length !== 1) {
		io.write(`${PLUGIN_NAME} migration-apply: expected exactly one settings-file path`);
		return 1;
	}
	const path = positional[0];
	if (path === void 0) {
		io.write(`${PLUGIN_NAME} migration-apply: expected exactly one settings-file path`);
		return 1;
	}
	const receipt = await surface.migration.apply(path, { ...expectedRevision === void 0 ? {} : { expectedRevision } });
	io.write(applyText(receipt));
	switch (receipt.kind) {
		case "applied":
		case "no-change": return 0;
		case "conflict":
		case "aborted": return 1;
		default: return assertNever(receipt);
	}
}
/** Parse exactly one positional settings-file path; never echoes the value. */
function singlePathArgument(action, rest, io) {
	if (rest.length !== 1) {
		io.write(`${PLUGIN_NAME} ${action}: expected exactly one settings-file path`);
		return;
	}
	const path = rest[0];
	if (path === void 0 || path.length === 0) {
		io.write(`${PLUGIN_NAME} ${action}: expected exactly one settings-file path`);
		return;
	}
	return path;
}
//#endregion
//#region src/commands.ts
/**
* Host command surface for the OpenCode Go provider.
*
* `runCommand` dispatches one action to its renderer; the renderers convert
* control-seam outcomes into sanitized, deterministic output. The connect key
* is read from the input stream (never argv, never echoed); unknown actions
* and flags fail loudly with fixed categories. Exit codes map to
* success/failure.
*/
const COMMAND_ACTIONS = [
	"doctor",
	"status",
	"connect",
	"disconnect",
	"migration-dry-run",
	"migration-apply"
];
/** Stable help text rendered for `--help` and no arguments. */
function commandHelp() {
	return [
		`Usage: ${PLUGIN_NAME} <action> [args]`,
		"",
		"  doctor                test connectivity with one authenticated GET /models",
		"  status                report sanitized configured/lifecycle facts (no network)",
		"  connect               (Host-only) store the API key through the running Harness Web card",
		"  disconnect            (Host-only) remove the DSH credential through the running Harness Web card",
		"  migration-dry-run <settings-file>             show the exact migration diff",
		"  migration-apply <settings-file> [--revision <hash>]  apply the migration",
		""
	].join("\n");
}
function isAction(value) {
	return COMMAND_ACTIONS.some((action) => action === value);
}
/**
* Run one command action against the control seam and render sanitized output.
* @param argv - action plus its positional arguments.
* @param surface - the control seam the action operates on.
* @param io - output sink and stdin key reader.
* @returns the process exit code (0 success, 1 failure).
*/
async function runCommand(argv, surface, io) {
	const rawAction = argv[0];
	if (rawAction === void 0 || rawAction === "--help" || rawAction === "-h") {
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
			case "doctor": return renderDoctor(surface, rest, io);
			case "status": return renderStatus(surface, rest, io);
			case "connect": return renderConnect(surface, rest, io);
			case "disconnect": return renderDisconnect(surface, rest, io);
			case "migration-dry-run": return renderMigrationDryRun(surface, rest, io);
			case "migration-apply": return renderMigrationApply(surface, rest, io);
		}
	} catch {
		io.write(`${PLUGIN_NAME}: ${rawAction} failed`);
		return 1;
	}
}
//#endregion
//#region src/line-input.ts
/**
* One-line stdin decoding for the standalone CLI.
*
* `decodeLine` removes exactly ONE line terminator (LF, or CRLF) and NEVER
* trims: padded or control-carrying keys stay byte-identical so the control
* seam's canonical validation rejects them unchanged. An empty line maps to
* undefined (no key); a line of spaces is DATA and reaches validation, never
* a silent valid key.
*/
function decodeLine(text) {
	let line = text;
	if (line.endsWith("\n")) line = line.slice(0, -1);
	if (line.endsWith("\r")) line = line.slice(0, -1);
	if (line === "") return void 0;
	return line;
}
//#endregion
//#region src/bin.ts
/**
* Standalone command entry for the OpenCode Go provider bundle.
*
* `dsh plugin --profile <name> exec dsh-opencode-go-provider <action>` runs
* this module through the package's `bin`. The control seam is the boot-free
* standalone wiring: environment-backed read-only credentials, the embedded
* catalog and the real fetch. Mutating actions (connect/disconnect) report
* that the standalone surface cannot write the DSH credential store — the
* running Harness Host owns that. The connect key is read from stdin with
* exactly one line terminator stripped, never trimmed.
*/
/** Read exactly one decoded line from stdin; undefined on EOF/error. */
function readStdinLine() {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			process.stdin.pause();
			resolve(value);
		};
		process.stdin.setEncoding("utf8");
		let buffer = "";
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(decodeLine(buffer.slice(0, newline + 1)));
		});
		process.stdin.on("end", () => finish(decodeLine(buffer)));
		process.stdin.on("error", () => finish(void 0));
	});
}
async function main(argv) {
	return runCommand(argv, standaloneControl(), {
		write: (line) => process.stdout.write(`${line}\n`),
		readKey: readStdinLine
	});
}
const entry = process.argv[1];
if (entry !== void 0 && fileURLToPath(import.meta.url) === realpathSync(entry)) process.exitCode = await main(process.argv.slice(2));
//#endregion
export {};
