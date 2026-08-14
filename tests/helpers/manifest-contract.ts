/**
 * Package-contract validator (Plan Task 2).
 *
 * QA tooling only: given a package directory, reads its manifest and the
 * files the DSH bundle contract references, and returns machine-readable
 * contract violations. Never shipped — the tarball `files` allowlist excludes
 * `tests/`, and no production code imports this module.
 *
 * Each returned string names the exact manifest field or file that violates
 * the contract so failures are actionable ("dsh.bundle.patch", "cordis.patch.yml", ...).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, isStringArray } from "./type-guards.ts";

export const PACKAGE_NAME = "dsh-opencode-go-provider";
export const PACKAGE_VERSION = "0.1.0";
export const NODE_ENGINE = "^22.19.0 || >=24.0.0";
export const PACKAGE_MANAGER = "pnpm@11.7.0";
export const BUNDLE_ROW_ID = "llm-opencode-go";

export const REQUIRED_CLIENT_INJECT = [
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-locale",
] as const;

export const REQUIRED_PACKED_FILES = [
  "lib/index.js",
  "lib/index.d.ts",
  "lib/client.js",
  "cordis.patch.yml",
  "catalog/models.json",
  "catalog/patches.json",
  "catalog/deprecated.json",
  "catalog/quarantine.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;

export const REQUIRED_REPO_FILES = [
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.client.json",
  "tsdown.config.ts",
  "vitest.config.ts",
  "scripts/check-pack.mjs",
  "src/index.ts",
  "src/client/index.tsx",
] as const;

function listSourceFiles(srcDir: string): readonly string[] {
  if (!existsSync(srcDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

/**
 * Validate a bundle manifest directory. Returns a list of contract violations;
 * an empty list means the directory satisfies the package contract.
 */
export function validateBundleManifest(pkgDir: string): readonly string[] {
  const errors: string[] = [];

  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) {
    return ["missing file package.json"];
  }
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!isRecord(parsed)) {
    return ["package.json must be a JSON object"];
  }
  const pkg = parsed;

  // Identity and runtime contract.
  if (pkg.name !== PACKAGE_NAME) {
    errors.push(`package.name must be "${PACKAGE_NAME}"`);
  }
  if (pkg.version !== PACKAGE_VERSION) {
    errors.push(`package.version must be "${PACKAGE_VERSION}"`);
  }
  if (pkg.type !== "module") {
    errors.push(`package.type must be "module"`);
  }
  const engines = isRecord(pkg.engines) ? pkg.engines : undefined;
  if (engines?.node !== NODE_ENGINE) {
    errors.push(`package.engines.node must be "${NODE_ENGINE}"`);
  }
  if (pkg.packageManager !== PACKAGE_MANAGER) {
    errors.push(`package.packageManager must be "${PACKAGE_MANAGER}"`);
  }

  // DSH bundle and Web client injection contracts.
  const dshValue = isRecord(pkg.dsh) ? pkg.dsh : undefined;
  const bundle = isRecord(dshValue?.bundle) ? dshValue.bundle : undefined;
  const client = isRecord(dshValue?.client) ? dshValue.client : undefined;
  if (bundle?.patch !== "./cordis.patch.yml") {
    errors.push(`package.dsh.bundle.patch must be "./cordis.patch.yml"`);
  }
  if (client?.platform !== "web") {
    errors.push(`package.dsh.client.platform must be "web"`);
  }
  const injectValue = client === undefined ? undefined : client.inject;
  const inject = isStringArray(injectValue) ? injectValue : undefined;
  if (inject === undefined) {
    errors.push(`package.dsh.client.inject must be an array`);
  } else {
    for (const required of REQUIRED_CLIENT_INJECT) {
      if (!inject.includes(required)) {
        errors.push(`package.dsh.client.inject must include "${required}"`);
      }
    }
  }

  // Public exports contract.
  const exports_ = isRecord(pkg.exports) ? pkg.exports : undefined;
  if (exports_ === undefined) {
    errors.push(`package.exports must be an object`);
  } else {
    if (!("." in exports_)) errors.push(`package.exports is missing "."`);
    if (!("./client" in exports_)) errors.push(`package.exports is missing "./client"`);
    if (!("./cordis.patch.yml" in exports_)) errors.push(`package.exports is missing "./cordis.patch.yml"`);
    if (!("./package.json" in exports_)) errors.push(`package.exports is missing "./package.json"`);

    const root = isRecord(exports_["."]) ? exports_["."] : undefined;
    if (root?.types !== "./lib/index.d.ts") {
      errors.push(`package.exports["."].types must be "./lib/index.d.ts"`);
    }
    if (root?.default !== "./lib/index.js") {
      errors.push(`package.exports["."].default must be "./lib/index.js"`);
    }

    const clientExport: unknown = exports_["./client"];
    const clientDefault =
      typeof clientExport === "string"
        ? clientExport
        : isRecord(clientExport)
          ? clientExport.default
          : undefined;
    if (clientDefault !== "./lib/client.js") {
      errors.push(`package.exports["./client"].default must be "./lib/client.js"`);
    }
  }

  // Tarball allowlist contract.
  const files = isStringArray(pkg.files) ? pkg.files : undefined;
  if (files === undefined) {
    errors.push(`package.files must be an allowlist array`);
  } else {
    for (const entry of ["lib", "cordis.patch.yml", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      if (!files.includes(entry)) {
        errors.push(`package.files must include "${entry}"`);
      }
    }
    for (const forbidden of ["src", "tests", "scripts", "node_modules", ".env", "dist", "coverage"]) {
      if (files.some((f) => f === forbidden || f.startsWith(`${forbidden}/`))) {
        errors.push(`package.files must not include "${forbidden}"`);
      }
    }
  }

  // No workspace protocol and no DSH private src/* imports.
  for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = isRecord(pkg[section]) ? pkg[section] : undefined;
    if (deps === undefined) continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        errors.push(`package.${section}.${dep} must not use the workspace protocol`);
      }
    }
  }
  for (const file of listSourceFiles(join(pkgDir, "src"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/from\s+["'](@deepseek-ai\/[^"']*\/src[^"']*)["']/g)) {
      errors.push(`src/${file.slice(pkgDir.length + 1)} imports forbidden private path "${match[1]}"`);
    }
  }

  // Required repo files (entrypoints, configs, lockfile, pack gate).
  for (const file of REQUIRED_REPO_FILES) {
    if (!existsSync(join(pkgDir, file))) {
      errors.push(`missing file ${file}`);
    }
  }

  // Bundle patch layer contract.
  const patchPath = join(pkgDir, "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    errors.push(`missing file cordis.patch.yml`);
  } else {
    const patch = readFileSync(patchPath, "utf8");
    if (!patch.includes("- insert:")) {
      errors.push(`cordis.patch.yml must declare an insert block`);
    }
    if (!patch.includes(`id: ${BUNDLE_ROW_ID}`)) {
      errors.push(`cordis.patch.yml must insert row "${BUNDLE_ROW_ID}"`);
    }
    if (!patch.includes(`name: ${PACKAGE_NAME}`)) {
      errors.push(`cordis.patch.yml row must reference name "${PACKAGE_NAME}"`);
    }
  }

  return errors;
}
