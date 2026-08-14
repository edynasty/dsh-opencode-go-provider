#!/usr/bin/env node
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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommand } from "./commands.ts";
import { standaloneControl } from "./control.ts";
import { decodeLine } from "./line-input.ts";

/** Read exactly one decoded line from stdin; undefined on EOF/error. */
function readStdinLine(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      resolve(value);
    };
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        finish(decodeLine(buffer.slice(0, newline + 1)));
      }
    });
    process.stdin.on("end", () => finish(decodeLine(buffer)));
    process.stdin.on("error", () => finish(undefined));
  });
}

async function main(argv: readonly string[]): Promise<number> {
  return runCommand(argv, standaloneControl(), {
    write: (line) => process.stdout.write(`${line}\n`),
    readKey: readStdinLine,
  });
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === realpathSync(entry)) {
  process.exitCode = await main(process.argv.slice(2));
}
