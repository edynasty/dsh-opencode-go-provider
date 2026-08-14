import type { UserConfig } from "tsdown";

/** Host runtime packages provided by the DSH profile; never bundled. */
const HOST_EXTERNALS = [
  "@earendil-works/pi-ai",
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-web",
] as const;

export default [
  {
    entry: { index: "src/index.ts" },
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
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "esm",
    platform: "browser",
    target: "es2024",
    dts: true,
    clean: false,
    fixedExtension: false,
  },
] satisfies UserConfig[];
