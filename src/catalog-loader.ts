/**
 * Embedded catalog loader for the OpenCode Go provider.
 *
 * Reads the committed `catalog/models.json` artifact (Task 3) through the
 * boundary parsers and memoizes the parsed model list. The loader is lazy and
 * read-only: it performs no network, no writes, and no credential resolution,
 * so catalog browsing works while the provider is fully disconnected. The
 * catalog is public metadata — never a secret — so memoization is safe and
 * required for deterministic builds and tests.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogModel } from "./types.ts";
import { parseJsonFile, parseModelsManifest } from "./state-file.ts";

const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog", "models.json");

let memoized: readonly CatalogModel[] | undefined;

/**
 * Return the parsed embedded catalog models, ascending by id (the artifact is
 * already sorted; the parsers preserve order).
 * @returns the catalog models.
 */
export function embeddedCatalogModels(): readonly CatalogModel[] {
  if (memoized === undefined) {
    const text = readFileSync(ARTIFACT, "utf8");
    memoized = parseModelsManifest(parseJsonFile(text, "models.json")).models;
  }
  return memoized;
}
