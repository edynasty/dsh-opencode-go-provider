/**
 * Embedded catalog artifact loaders for the OpenCode Go provider.
 *
 * Reads the committed `catalog/models.json` (manifest) and `catalog/patches.json`
 * artifacts (Task 3) through the boundary parsers and memoizes the results.
 * The loaders are lazy and read-only: no network, no writes, no credential
 * resolution, so catalog browsing works while the provider is fully
 * disconnected. The artifacts are public metadata — never secrets — so
 * memoization is safe and required for deterministic builds and tests.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogModel, Patches } from "./types.ts";
import { parseJsonFile, parseModelsManifest, parsePatchesFile } from "./state-file.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MODELS_ARTIFACT = join(REPO_ROOT, "catalog", "models.json");
const PATCHES_ARTIFACT = join(REPO_ROOT, "catalog", "patches.json");

let memoizedManifest: ReturnType<typeof parseModelsManifest> | undefined;
let memoizedPatches: Patches | undefined;

/**
 * Return the parsed embedded manifest: generatedAt, provenance, availability
 * and the ascending-id model list (the artifact is already sorted; the
 * parsers preserve order).
 * @returns the parsed embedded catalog manifest.
 */
export function embeddedCatalogManifest(): ReturnType<typeof parseModelsManifest> {
  if (memoizedManifest === undefined) {
    const text = readFileSync(MODELS_ARTIFACT, "utf8");
    memoizedManifest = parseModelsManifest(parseJsonFile(text, "models.json"));
  }
  return memoizedManifest;
}

/**
 * Return the parsed embedded catalog models, ascending by id.
 * @returns the catalog models.
 */
export function embeddedCatalogModels(): readonly CatalogModel[] {
  return embeddedCatalogManifest().models;
}

/**
 * Return the parsed committed patch layer (the sole source for the anthropic
 * base URL override), memoized.
 * @returns the parsed patches.
 */
export function embeddedPatches(): Patches {
  if (memoizedPatches === undefined) {
    const text = readFileSync(PATCHES_ARTIFACT, "utf8");
    memoizedPatches = parsePatchesFile(parseJsonFile(text, "patches.json"));
  }
  return memoizedPatches;
}
