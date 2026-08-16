#!/usr/bin/env node
/**
 * Client declarations pass (Task 12 owning-todo).
 *
 * tsdown's cjs dts pass cannot type the __ModuleLoader__-wrapped browser
 * bundle (it emits an empty re-export shim), so the shipped `lib/client.d.ts`
 * comes from a dedicated ESM dts build into a staging dir, then is moved
 * next to the wrapped `lib/client.js`. Must run after the main tsdown build
 * (the `build` script chains it), so the staging write never races lib/.
 */
import { build } from "tsdown";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "dsh-opencode-go-provider-client-dts-"));
try {
  await build({
    cwd: REPO_ROOT,
    config: false,
    entry: { client: "src/client/index.tsx" },
    outDir: staging,
    format: "esm",
    platform: "browser",
    target: "es2024",
    dts: true,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"] },
    logLevel: "warn",
  });
  const emitted = join(staging, "client.d.ts");
  if (!existsSync(emitted)) throw new Error(`client declarations were not emitted at ${emitted}`);
  cpSync(emitted, join(REPO_ROOT, "lib", "client.d.ts"));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
