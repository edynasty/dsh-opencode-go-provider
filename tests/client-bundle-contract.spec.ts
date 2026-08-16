/**
 * Client bundle loader-contract regression (Task 12 owning-todo, red-first).
 *
 * The DSH web host consumes browser plugin bundles exclusively through the
 * module-loader contract: the shipped `lib/client.js` must be a side-effect
 * script whose single statement calls `window.__ModuleLoader__.load({ id,
 * factory })` with a CJS-style factory resolving its dependencies (react,
 * react/jsx-runtime) through the injected `require`. A raw-ESM artifact
 * (`import ... from "react"` at the top) cannot be consumed by the loader and
 * the Connect card never renders.
 *
 * Two layers are pinned here:
 *  1. Static: the built artifact's shape (loader wrapper, id, no bare-ESM
 *     externals).
 *  2. Runtime: evaluating the artifact against the loader contract registers
 *     the module and yields the expected exports — the exact handoff the DSH
 *     web host performs, including the "loaded without registering" failure
 *     mode this fix removes.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../src/guards.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_JS = join(REPO_ROOT, "lib", "client.js");
const CLIENT_ID = "dsh-opencode-go-provider";

/** Loader options shape the DSH web host passes into `load`. */
interface LoaderOptions {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => unknown;
}

interface LoadedClient {
  readonly name: unknown;
  readonly inject: unknown;
  readonly apply: unknown;
  readonly clientContract: unknown;
}

describe("lib/client.js module-loader contract", () => {
  it("is a __ModuleLoader__.load script, not raw ESM", async () => {
    // Given: the shipped browser bundle.
    const source = await readFile(CLIENT_JS, "utf8");
    // Then: the file is a single loader handoff...
    expect(source.trimStart().startsWith("window.__ModuleLoader__.load({")).toBe(true);
    // ...stamped with this bundle's module id...
    expect(source).toContain(`id: ${JSON.stringify(CLIENT_ID)}`);
    // ...whose factory is the CJS-style `(require) => { ... }` closure...
    expect(source).toContain("factory: (require) => {");
    // ...ending with the module-exports handoff the loader contract reads
    // (whitespace-insensitive: the bundler re-formats the addon text).
    const flattened = source.trim().replace(/\s+/g, " ");
    expect(flattened.endsWith("return module.exports; } });")).toBe(true);
    // ...and the first statement is NOT a bare ESM import of externals.
    const firstLine = source.split("\n")[0];
    if (firstLine !== undefined) {
      expect(firstLine.startsWith("import ")).toBe(false);
    }
  });

  it("registers the module through the loader at evaluation time", async () => {
    // Given: the loader contract installed exactly like the DSH web host's
    // (the factory's require resolves the bundle's externals — here the real
    // react from this repo, the host serves its own instances).
    const repoRequire = createRequire(join(REPO_ROOT, "package.json"));
    const loaded = new Map<string, unknown>();
    window.__ModuleLoader__ = {
      load: ({ id, factory }: LoaderOptions) => {
        const exports = factory((specifier) => repoRequire(specifier));
        loaded.set(id, exports);
        return exports;
      },
    };
    // When: the shipped bundle evaluates (browser fetch + loader execute).
    await import("../lib/client.js");
    // Then: the module REGISTERED under its id — a raw-ESM artifact registers
    // nothing and the host reports "loaded without registering".
    const exports = loaded.get(CLIENT_ID);
    expect(isRecord(exports)).toBe(true);
    const client = exports as LoadedClient;
    expect(client.name).toBe("dsh-opencode-go-provider-client");
    expect(typeof client.apply).toBe("function");
    // ...and the machine-consumed client contract is exposed for the Host.
    expect(isRecord(client.clientContract)).toBe(true);
    expect(client.inject).toEqual(["slots", "locale"]);
  });
});
