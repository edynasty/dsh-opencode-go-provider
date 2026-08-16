/**
 * Task 8 Host/client loader: spawns a child Node process that mounts the
 * profile patch rows on a real Cordis host (LlmRuntime + the installed bundle
 * plugin) with injected offline seams, loads the client contract from the
 * installed bytes, and calls `listModels` against the embedded catalog.
 */
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAKE_KEY, REPO_ROOT, isolatedEnv } from "./release-candidate-subprocess.ts";
import type { Profile } from "./packed-profile.ts";
import { isRecord, isString } from "./type-guards.ts";

export interface HostLoadResult {
  readonly bundleRows: readonly string[];
  readonly providers: readonly string[];
  readonly configurableProviders: readonly string[];
  readonly modelCount: number;
  readonly firstModelId: string | undefined;
  readonly client: {
    readonly name: string;
    readonly providerRoute: string;
    readonly apiKeyEnv: string;
    readonly inject: readonly string[];
    readonly remoteRoutes: readonly string[];
  };
}

/** The child Host-load script: mounts the profile patch rows on a real host. */
const HOST_LOAD_SCRIPT = `
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const profileRoot = process.env.PROFILE_ROOT;
const dshHome = process.env.DSH_HOME;
if (!profileRoot || !dshHome) throw new Error("PROFILE_ROOT and DSH_HOME must be set");

// The DSH web host consumes browser bundles through the module loader: the
// client artifact calls window.__ModuleLoader__.load({ id, factory }) and the
// loader reads the factory's module.exports. Mirror that handoff in Node —
// the factory's require resolves the bundle's externals (react, ...) from the
// provider repo, which carries them as devDependencies.
const repoRequire = createRequire(join(process.env.PROVIDER_REPO ?? "", "package.json"));
const loaded = {};
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      const exports = factory((specifier) => repoRequire(specifier));
      loaded[id] = exports;
      return exports;
    },
  },
};

const patch = parse(await readFile(join(profileRoot, "cordis.patch.yml"), "utf8"));
const rows = [];
for (const op of Array.isArray(patch) ? patch : []) {
  if (op && typeof op === "object" && Array.isArray(op.insert)) {
    for (const row of op.insert) {
      if (row && typeof row === "object" && typeof row.id === "string" && typeof row.name === "string") {
        rows.push({ id: row.id, name: row.name });
      }
    }
  }
}

const ctx = new Context();
const llm = new LlmRuntime(ctx);
// Injected offline seams: fail-closed network and a temp cache home.
ctx.provide("opencodeGoFetch", () => { throw new Error("offline: no network"); });
ctx.provide("opencodeGoHome", dshHome);

const fibers = [];
for (const row of rows) {
  const mod = await import(row.name);
  if (typeof mod.apply !== "function") throw new Error(\`bundle row \${row.id} exposes no apply\`);
  fibers.push(ctx.plugin(mod.apply, {}));
}
await Promise.all(fibers);

const providers = ctx.llm.listProviders().map((p) => p.id);
const configurableProviders = ctx.llm.listConfigurableProviders().map((p) => p.provider);
const models = await ctx.llm.listModels("opencode-go");
// Load the client contract through the loader handoff like the web host. The
// ESM-namespace fallback only serves historical pinned commits whose client
// artifact predates the loader contract; current artifacts MUST register
// through the loader (enforced by client-bundle-contract.spec and the packed
// import gates), and for them the namespace carries no exports.
const clientModule = await import("dsh-opencode-go-provider/client");
const client = loaded["dsh-opencode-go-provider"] ?? clientModule;
const result = {
  bundleRows: rows.map((r) => r.id),
  providers,
  configurableProviders,
  modelCount: models.length,
  firstModelId: models[0]?.id ?? null,
  client: client?.clientContract ?? null,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

/** Parse the child Host-load stdout into a typed result. */
function parseHostLoadResult(value: unknown): HostLoadResult {
  if (!isRecord(value)) throw new Error("host load output must be an object");
  const bundleRows = Array.isArray(value.bundleRows) ? value.bundleRows.filter(isString) : [];
  const providers = Array.isArray(value.providers) ? value.providers.filter(isString) : [];
  const configurableProviders = Array.isArray(value.configurableProviders)
    ? value.configurableProviders.filter(isString)
    : [];
  if (typeof value.modelCount !== "number" || !Number.isInteger(value.modelCount) || value.modelCount < 0) {
    throw new Error("host load output modelCount must be a nonnegative integer");
  }
  const firstModelId = value.firstModelId === null || value.firstModelId === undefined
    ? undefined
    : isString(value.firstModelId)
      ? value.firstModelId
      : undefined;
  const client = isRecord(value.client) ? value.client : undefined;
  if (
    client === undefined
    || !isString(client.name)
    || !isString(client.providerRoute)
    || !isString(client.apiKeyEnv)
    || !Array.isArray(client.inject)
    || !client.inject.every(isString)
    || !Array.isArray(client.remoteRoutes)
    || !client.remoteRoutes.every(isString)
  ) {
    throw new Error("host load output client contract is malformed");
  }
  return {
    bundleRows,
    providers,
    configurableProviders,
    modelCount: value.modelCount,
    firstModelId,
    client: {
      name: client.name,
      providerRoute: client.providerRoute,
      apiKeyEnv: client.apiKeyEnv,
      inject: client.inject,
      remoteRoutes: client.remoteRoutes,
    },
  };
}

/** Load the Host and client from the installed package bytes in a child Node. */
export async function loadHostAndClient(profile: Profile): Promise<HostLoadResult> {
  const scriptPath = join(profile.root, "host-load.mjs");
  await writeFile(scriptPath, HOST_LOAD_SCRIPT);
  try {
    const env = isolatedEnv(profile.root, {
      DSH_HOME: profile.root,
      PROFILE_ROOT: profile.root,
      PROVIDER_REPO: REPO_ROOT,
      OPENCODE_GO_API_KEY: FAKE_KEY,
    });
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: profile.root,
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
    if (result.status !== 0) {
      throw new Error(
        `host load failed (exit ${String(result.status)}): ${(result.stderr ?? "").trim().slice(0, 800)}`,
      );
    }
    return parseHostLoadResult(JSON.parse(result.stdout));
  } finally {
    // The generated child script never remains in the profile, on success or
    // failure; the snapshot's rootEntries field would otherwise flag it.
    await rm(scriptPath, { force: true });
  }
}
