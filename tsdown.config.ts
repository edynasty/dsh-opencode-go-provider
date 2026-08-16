import type { UserConfig } from "tsdown";

/** Host runtime packages provided by the DSH profile; never bundled. */
const HOST_EXTERNALS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/**",
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-web",
] as const;

/** Browser externals the DSH web host resolves through the loader's require. */
const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
] as const;

export default [
  {
    entry: { index: "src/index.ts", bin: "src/bin.ts" },
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: true,
    clean: true,
    fixedExtension: false,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    // DSH web client-module loader contract: the artifact must be a
    // side-effect script whose single statement hands the module to
    // `window.__ModuleLoader__.load({ id, factory })`; the factory is a
    // CJS-style closure resolving externals (react, ...) through the
    // loader-injected `require` and returning `module.exports`. The intro
    // provides the CJS shim variables the rolldown output references. A
    // raw-ESM artifact cannot be consumed and the Connect card never
    // renders ("loaded without registering"). Types ship via the
    // scripts/emit-client-dts.mjs declarations pass.
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: "dsh-opencode-go-provider", factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];
