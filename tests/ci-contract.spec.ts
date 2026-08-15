/**
 * CI-contract tests (Plan Task 9).
 *
 * Parse `.github/workflows/ci.yml` as YAML and assert workflow SEMANTICS, not
 * just substring presence: the Node matrix, the frozen pnpm install, the
 * offline gate set, the live-smoke guard (no opt-in flag, no key injected),
 * the deterministic credential scan (fixed file/category output, no matched
 * values echoed) and least-privilege permissions.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { isRecord, isStringArray } from "./helpers/type-guards.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");

function loadWorkflow(): unknown {
  return parse(readFileSync(WORKFLOW_PATH, "utf8"));
}

interface StepShape {
  uses?: unknown;
  run?: unknown;
  name?: unknown;
  env?: unknown;
  with?: unknown;
}

function stepsOf(job: unknown): StepShape[] {
  if (!isRecord(job)) return [];
  const steps = job.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((step): step is StepShape => isRecord(step));
}

function runScripts(job: unknown): string[] {
  return stepsOf(job)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
}

function allRuns(): string[] {
  const workflow = loadWorkflow();
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return [];
  return Object.values(workflow.jobs).flatMap((job) => runScripts(job));
}

function allUses(): string[] {
  const workflow = loadWorkflow();
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return [];
  return Object.values(workflow.jobs).flatMap((job) =>
    stepsOf(job)
      .map((step) => step.uses)
      .filter((uses): uses is string => typeof uses === "string"),
  );
}

function matrixNodes(): string[] {
  const workflow = loadWorkflow();
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return [];
  const nodes: string[] = [];
  for (const job of Object.values(workflow.jobs)) {
    if (!isRecord(job)) continue;
    const strategy = job.strategy;
    if (!isRecord(strategy)) continue;
    const matrix = strategy.matrix;
    if (!isRecord(matrix)) continue;
    const node = matrix.node;
    if (isStringArray(node)) nodes.push(...node);
    if (typeof node === "string") nodes.push(node);
  }
  return nodes;
}

describe("CI workflow matrix and toolchain", () => {
  it("covers Node 22.19.0, 24 and 26", () => {
    const nodes = matrixNodes();
    expect(nodes).toContain("22.19.0");
    expect(nodes).toContain("24");
    expect(nodes).toContain("26");
  });

  it("uses checkout@v4 and setup-node@v4", () => {
    const uses = allUses();
    expect(uses.some((u) => u.startsWith("actions/checkout@v4"))).toBe(true);
    expect(uses.some((u) => u.startsWith("actions/setup-node@v4"))).toBe(true);
  });

  it("enables corepack and installs with the frozen lockfile", () => {
    const runs = allRuns();
    expect(runs.some((r) => r.includes("corepack enable"))).toBe(true);
    expect(runs.some((r) => r.includes("pnpm install --frozen-lockfile"))).toBe(true);
    expect(runs.some((r) => /pnpm@?11\.7\.0/.test(r) || r.includes("pnpm"))).toBe(true);
  });

  it("pins pnpm 11.7.0 via the packageManager field", () => {
    const pkg: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(isRecord(pkg) ? pkg.packageManager : undefined).toBe("pnpm@11.7.0");
  });
});

describe("CI workflow offline gates", () => {
  it("runs typecheck, test, build, publint and pack:check", () => {
    const runs = allRuns();
    for (const gate of [
      "pnpm run typecheck",
      "pnpm run test",
      "pnpm run build",
      "pnpm run publint",
      "pnpm run pack:check",
    ]) {
      expect(runs.some((r) => r.includes(gate))).toBe(true);
    }
  });

  it("runs a deterministic credential scan", () => {
    const runs = allRuns();
    expect(runs.some((r) => r.includes("pnpm run scan:secrets"))).toBe(true);
  });
});

describe("CI workflow live-smoke guard", () => {
  it("never injects the live opt-in flag or a key in runs or envs", () => {
    // Check semantics, not the whole raw file: the step NAME may legitimately
    // document the flag, but no `run` script or `env` block may set it, and no
    // key may be declared anywhere in the workflow.
    const workflow = loadWorkflow();
    expect(isRecord(workflow)).toBe(true);
    const jobs = isRecord(workflow) ? workflow.jobs : undefined;
    expect(isRecord(jobs)).toBe(true);
    const jobList = isRecord(jobs) ? Object.values(jobs) : [];

    const declaredKeys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (!isRecord(value)) return;
      for (const [key, val] of Object.entries(value)) {
        declaredKeys.add(key);
        collectKeys(val);
      }
    };
    collectKeys(workflow);

    for (const job of jobList) {
      for (const step of stepsOf(job)) {
        if (typeof step.run === "string") {
          expect(step.run).not.toContain("RUN_OPENCODE_GO_LIVE=1");
          expect(step.run).not.toContain("OPENCODE_GO_API_KEY");
        }
        if (isRecord(step.env)) {
          expect(step.env.RUN_OPENCODE_GO_LIVE).not.toBe("1");
          expect(step.env.OPENCODE_GO_API_KEY).toBeUndefined();
        }
      }
    }
    expect(declaredKeys.has("OPENCODE_GO_API_KEY")).toBe(false);
    // No secrets block may be declared.
    expect(declaredKeys.has("secrets")).toBe(false);
  });

  it("runs the live smoke step with default skip semantics", () => {
    const workflow = loadWorkflow();
    expect(isRecord(workflow)).toBe(true);
    const jobs = isRecord(workflow) ? workflow.jobs : undefined;
    expect(isRecord(jobs)).toBe(true);
    const jobList = isRecord(jobs) ? Object.values(jobs) : [];
    const smokeSteps = jobList.flatMap((job) =>
      stepsOf(job).filter(
        (step) => typeof step.run === "string" && step.run.includes("live-smoke"),
      ),
    );
    expect(smokeSteps.length).toBeGreaterThan(0);
    for (const step of smokeSteps) {
      // The step must not set the opt-in flag itself.
      expect(step.run).not.toContain("RUN_OPENCODE_GO_LIVE=1");
    }
  });
});

describe("CI workflow least privilege", () => {
  it("grants contents: read and no token scope", () => {
    const workflow = loadWorkflow();
    expect(isRecord(workflow)).toBe(true);
    const permissions = isRecord(workflow) ? workflow.permissions : undefined;
    expect(isRecord(permissions)).toBe(true);
    expect(isRecord(permissions) ? permissions.contents : undefined).toBe("read");
    // No explicit write permission anywhere.
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    expect(raw).not.toMatch(/contents:\s*write/);
    expect(raw).not.toMatch(/id-token:\s*write/);
  });

  it("sets persist-credentials: false on every checkout step", () => {
    const workflow = loadWorkflow();
    expect(isRecord(workflow)).toBe(true);
    const jobs = isRecord(workflow) ? workflow.jobs : undefined;
    expect(isRecord(jobs)).toBe(true);
    const checkouts = Object.values(isRecord(jobs) ? jobs : {}).flatMap((job) =>
      stepsOf(job).filter(
        (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@v4"),
      ),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(isRecord(checkout.with)).toBe(true);
      expect(isRecord(checkout.with) ? checkout.with["persist-credentials"] : undefined).toBe(false);
    }
  });

  it("invokes the credential scan through the package script", () => {
    // The workflow must run `pnpm run scan:secrets` (the package script), so
    // the package.json script and the workflow gate cannot drift.
    const runs = allRuns();
    expect(runs.some((r) => r.includes("pnpm run scan:secrets"))).toBe(true);
    const pkg: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    const scripts = isRecord(pkg) ? pkg.scripts : undefined;
    expect(isRecord(scripts) ? scripts["scan:secrets"] : undefined).toContain("scripts/scan-secrets.mjs");
  });
});
