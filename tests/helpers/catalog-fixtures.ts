/**
 * Shared fixtures and builders for the Task 3 catalog/reconciliation specs.
 *
 * Reads the frozen inputs under catalog/fixtures/ and builds tiny inline
 * models.dev providers for state-machine tests. Test-only; never shipped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseLiveIds, parseModelsDevProvider } from "../../src/models-dev.ts";
import type { ModelsDevProvider } from "../../src/types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FIXTURE_DIR = join(REPO_ROOT, "catalog", "fixtures");

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** Read any repo file by path relative to the repository root. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** Parsed frozen models.dev opencode-go provider (24 models). */
export function modelsDevFixture(): ModelsDevProvider {
  const parsed: unknown = JSON.parse(readFixture("models-dev-opencode-go.json"));
  return parseModelsDevProvider(parsed);
}

/** Live IDs from the frozen 25-id fixture (24 known + synthetic probe). */
export function liveFixtureIds(): readonly string[] {
  const parsed: unknown = JSON.parse(readFixture("live-models.json"));
  return parseLiveIds(parsed);
}

export const PROVIDER_NPM = "@ai-sdk/openai-compatible" as const;
export const PROVIDER_API = "https://opencode.ai/zen/go/v1" as const;

/**
 * Build a minimal valid models.dev provider from raw model records. Records
 * pass through the real boundary parser, never structural `as`.
 */
export function makeProvider(
  models: Readonly<Record<string, unknown>>,
  npm: string | undefined = PROVIDER_NPM,
  api: string | undefined = PROVIDER_API,
): ModelsDevProvider {
  return parseModelsDevProvider({ id: "opencode-go", name: "OpenCode Go", npm, api, models });
}

/** Minimal structurally-valid models.dev model record. */
export function makeModel(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    name: `${id} name`,
    reasoning: true,
    limit: { context: 100_000, output: 20_000 },
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 0.1, output: 0.2 },
    ...overrides,
  };
}

/** Committed anthropic base URL patch used across specs. */
export function makePatches(): Readonly<Record<string, unknown>> {
  return {
    baseUrlByProtocol: {
      "anthropic-messages": {
        baseUrl: "https://opencode.ai/zen/go",
        evidence: "opencode.ai/docs/go endpoint table 2026-08-14",
      },
    },
  };
}
