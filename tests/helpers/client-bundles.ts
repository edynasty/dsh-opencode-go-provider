/**
 * Loader-boundary extraction for the DSH web client bundles (test-only).
 *
 * The DSH web client packages ship as ModuleLoader bundles: the file is a
 * side-effect script whose only statement calls `window.__ModuleLoader__.load`
 * and DISCARDS the return — the loader's return value IS the module's
 * exports, and only the browser host's loader contract can read it. This
 * helper installs that contract (the `require` map serves the real ESM
 * modules) and extracts the typed classes from the loader return.
 *
 * The two `as` assertions at the bottom are the ONLY casts in the Task 7
 * test surface and they sit at a genuine trust boundary: the same handoff the
 * DSH web host performs when it consumes a bundle's `module.exports`. Each is
 * preceded by a runtime membership/function guard, so a malformed bundle
 * fails the test instead of producing an untyped value.
 */
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-runtime/client";
import { isRecord } from "../../src/guards.ts";

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(options: { id: string; factory: (require: (specifier: string) => unknown) => unknown }): unknown;
    };
  }
}

const loaded = new Map<string, unknown>();

/** The `require` contract each bundle's factory consumes. */
async function installLoader(): Promise<void> {
  const cordis = await import("@deepseek-ai/cordis");
  const uiSlots = await import("@deepseek-ai/dsh-client-ui-slots");
  const react = await import("react");
  const jsxRuntime = await import("react/jsx-runtime");
  const primitives = await import("@deepseek-ai/dsh-client-ui-primitives");
  let runtimeExports: unknown;
  window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      const cached = loaded.get(id);
      if (cached !== undefined) return cached;
      const exports = factory((specifier) => {
        switch (specifier) {
          case "@deepseek-ai/cordis":
            return cordis;
          case "@deepseek-ai/dsh-client-ui-slots":
            return uiSlots;
          case "react":
            return react;
          case "react/jsx-runtime":
            return jsxRuntime;
          case "@deepseek-ai/dsh-client-ui-primitives":
            return primitives;
          case "@deepseek-ai/dsh-client-runtime/client": {
            if (runtimeExports === undefined) {
              throw new Error("test loader: runtime bundle not loaded yet");
            }
            return runtimeExports;
          }
          default:
            throw new Error(`test loader: unprovided module ${specifier}`);
        }
      });
      loaded.set(id, exports);
      return exports;
    },
  };
  await import("@deepseek-ai/dsh-client-runtime/client");
  runtimeExports = loaded.get("@deepseek-ai/dsh-client-runtime");
  await import("@deepseek-ai/dsh-client-locale/client");
}

/** A named member of a loaded bundle, verified to be a function. */
function bundleMember(id: string, name: string): unknown {
  const record = loaded.get(id);
  if (isRecord(record) && typeof record[name] === "function") {
    return record[name];
  }
  throw new Error(`test loader: ${id} does not export a function ${name}`);
}

export interface LoadedClientModules {
  readonly SlotRegistry: typeof SlotRegistry;
  readonly LocaleRuntime: typeof LocaleRuntime;
}

/** Install the loader and load the real bundles; returns their typed classes. */
export async function loadClientModules(): Promise<LoadedClientModules> {
  await installLoader();
  return {
    SlotRegistry: bundleMember("@deepseek-ai/dsh-client-runtime", "SlotRegistry") as typeof SlotRegistry,
    LocaleRuntime: bundleMember("@deepseek-ai/dsh-client-locale", "LocaleRuntime") as typeof LocaleRuntime,
  };
}
