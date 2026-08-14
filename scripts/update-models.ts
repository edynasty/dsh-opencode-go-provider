/**
 * OpenCode Go catalog generator CLI.
 *
 * Default mode is bootstrap: the embedded catalog is derived from the frozen
 * public models.dev metadata with availability explicitly unverified — no
 * synthetic live assertion, no fabricated quarantine or deprecated state.
 * `--live <file>` reconciles against an explicit live ids payload (test
 * fixtures); `--network` requires OPENCODE_GO_API_KEY and fails closed before
 * any write when it is absent or the live capture fails. The clock is
 * injected once (`--now` or the wall at startup); no timestamp is rewritten
 * when inputs and state are unchanged. The pure generation core lives in
 * src/generator.ts; this module owns argv, fs and network.
 *
 * Usage:
 *   node scripts/update-models.ts [--out <dir>] [--state <dir>]
 *     [--patches <file>] [--live <file>] [--now <iso>] [--provenance <text>]
 *     [--network] [--help]
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCatalogFiles } from "../src/generator.ts";
import { parseLiveIds } from "../src/models-dev.ts";
import { parseJsonFile } from "../src/state-file.ts";
import { fetchNetworkSources } from "./sources.ts";
import type { LiveSource, ReconcileStats } from "../src/types.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const DEFAULT_OUT_DIR = join(REPO_ROOT, "catalog");
export const DEFAULT_FIXTURES_DIR = join(REPO_ROOT, "catalog", "fixtures");
export const DEFAULT_PATCHES_FILE = join(DEFAULT_OUT_DIR, "patches.json");

interface CliOptions {
  readonly outDir: string;
  readonly stateDir: string;
  readonly fixturesDir: string;
  readonly patchesFile: string;
  readonly liveFile: string | undefined;
  readonly now: Date;
  readonly provenance: string | undefined;
  readonly network: boolean;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

/** Parse CLI arguments; conflicting modes fail before any fetch or write. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let outDir = DEFAULT_OUT_DIR;
  let stateDir: string | undefined;
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let patchesFile = DEFAULT_PATCHES_FILE;
  let liveFile: string | undefined;
  let now: Date | undefined;
  let provenance: string | undefined;
  let network = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case "--out":
        if (value === undefined) throw new Error("--out requires a directory");
        outDir = value;
        index += 1;
        break;
      case "--state":
        if (value === undefined) throw new Error("--state requires a directory");
        stateDir = value;
        index += 1;
        break;
      case "--fixtures":
        if (value === undefined) throw new Error("--fixtures requires a directory");
        fixturesDir = value;
        index += 1;
        break;
      case "--patches":
        if (value === undefined) throw new Error("--patches requires a file");
        patchesFile = value;
        index += 1;
        break;
      case "--live":
        if (value === undefined) throw new Error("--live requires a file");
        liveFile = value;
        index += 1;
        break;
      case "--now":
        if (value === undefined) throw new Error("--now requires an ISO timestamp");
        now = new Date(value);
        if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid timestamp: ${value}`);
        index += 1;
        break;
      case "--provenance":
        if (value === undefined) throw new Error("--provenance requires text");
        provenance = value;
        index += 1;
        break;
      case "--network":
        network = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (network && liveFile !== undefined) {
    throw new Error("--network and --live are mutually exclusive; supply only one live source");
  }
  return {
    outDir,
    stateDir: stateDir ?? outDir,
    fixturesDir,
    patchesFile,
    liveFile,
    now: now ?? new Date(),
    provenance,
    network,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "usage: node scripts/update-models.ts [options]",
      "",
      "  --out <dir>        output directory (default: catalog/)",
      "  --state <dir>      directory holding previous state (default: --out)",
      "  --fixtures <dir>   frozen metadata fixture directory (default: catalog/fixtures/)",
      "  --patches <file>   patches artifact (default: catalog/patches.json)",
      "  --live <file>      reconcile against an explicit live ids payload (test fixtures)",
      "  --now <iso>        fixed clock for reproducible runs (default: now)",
      "  --provenance <t>   provenance string written into models.json",
      "  --network          fetch models.dev + live ids; requires OPENCODE_GO_API_KEY",
      "  --help             print this help",
      "",
    ].join("\n"),
  );
}

async function loadSources(options: CliOptions): Promise<{
  readonly modelsDev: string;
  readonly live: { readonly liveJson: string; readonly source: LiveSource } | undefined;
  readonly provenance: string;
}> {
  const metadataProvenance = "models.dev snapshot 2026-08-14 (public metadata only; availability unverified until a live refresh)";
  if (options.network) {
    const sources = await fetchNetworkSources(process.env.OPENCODE_GO_API_KEY);
    const liveIds = parseLiveIds(parseJsonFile(sources.liveJson, "live /models"));
    return {
      modelsDev: sources.modelsDevJson,
      live: { liveJson: sources.liveJson, source: "live" },
      provenance: options.provenance ?? `network models.dev 2026-08-14; live ids captured: ${liveIds.length}`,
    };
  }
  if (options.liveFile !== undefined) {
    return {
      modelsDev: readFileSync(join(options.fixturesDir, "models-dev-opencode-go.json"), "utf8"),
      live: { liveJson: readFileSync(options.liveFile, "utf8"), source: "fixture" },
      provenance: options.provenance ?? `${metadataProvenance}; live ids from explicit payload: fixture`,
    };
  }
  return {
    modelsDev: readFileSync(join(options.fixturesDir, "models-dev-opencode-go.json"), "utf8"),
    live: undefined,
    provenance: options.provenance ?? metadataProvenance,
  };
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function summarize(stats: ReconcileStats, generatedAt: string, transitioned: boolean): void {
  process.stdout.write(
    [
      `models: ${stats.known} known, ${stats.live} live, ${stats.quarantined} quarantined`,
      `deprecated: ${stats.deprecated} in grace (${stats.evicted} evicted, ${stats.resurrected} resurrected)`,
      `generatedAt: ${generatedAt}${transitioned ? "" : " (unchanged)"}`,
      "",
    ].join("\n"),
  );
}

/** CLI entry; only runs when executed directly, never under vitest. */
export async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const sources = await loadSources(options);
  const output = generateCatalogFiles({
    modelsDevJson: sources.modelsDev,
    patchesJson: readFileSync(options.patchesFile, "utf8"),
    live: sources.live,
    previousModelsJson: readOptional(join(options.stateDir, "models.json")),
    previousQuarantineJson: readOptional(join(options.stateDir, "quarantine.json")),
    previousDeprecatedJson: readOptional(join(options.stateDir, "deprecated.json")),
    now: options.now,
    provenance: sources.provenance,
  });
  for (const [name, content] of Object.entries(output.files)) {
    writeAtomic(join(options.outDir, name), content);
  }
  summarize(output.stats, output.generatedAt, output.transitioned);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`update-models failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
