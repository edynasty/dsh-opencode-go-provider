/**
 * Runtime parsers for the Task 2 pack-import QA.
 *
 * These parse untrusted external output — `npm pack --json` stdout, the packed
 * package.json, and the spawned consumer process stdout — from `unknown` into
 * typed values at the boundary, rejecting malformed input with actionable
 * errors. No production code imports them.
 */
import { isRecord, isString, isUnknownArray } from "./type-guards.ts";

export interface PackManifest {
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

export interface PackedPackageJson {
  readonly name: string;
  readonly version: string;
  readonly dsh?: { readonly bundle?: { readonly patch: string } };
}

export interface ConsumerResult {
  readonly ok: boolean;
  readonly root: { readonly name: string; readonly route: string; readonly apiKeyEnv: string };
  readonly client: { readonly name: string; readonly providerRoute: string; readonly apiKeyEnv: string };
}

/** Parse `npm pack --json` stdout: a single-entry array with filename + files. */
export function parsePackManifest(value: unknown): PackManifest {
  if (!isUnknownArray(value) || value.length !== 1) {
    throw new Error(`npm pack --json output must be a single-entry array`);
  }
  const entry: unknown = value[0];
  if (!isRecord(entry)) {
    throw new Error(`npm pack --json entry must be an object`);
  }
  if (!isString(entry.filename) || !entry.filename.endsWith(".tgz")) {
    throw new Error(`npm pack --json entry.filename must be a .tgz string; got ${String(entry.filename)}`);
  }
  const filesValue = isUnknownArray(entry.files) ? entry.files : undefined;
  if (filesValue === undefined) {
    throw new Error(`npm pack --json entry.files must be an array`);
  }
  const files: { readonly path: string }[] = [];
  for (const file of filesValue) {
    if (!isRecord(file) || !isString(file.path)) {
      throw new Error(`npm pack --json entry.files[].path must be a string`);
    }
    files.push({ path: file.path });
  }
  return { filename: entry.filename, files };
}

/** Parse the package.json extracted from the tarball. */
export function parsePackedPackageJson(value: unknown): PackedPackageJson {
  if (!isRecord(value)) {
    throw new Error(`packed package.json must be a JSON object`);
  }
  if (!isString(value.name) || !isString(value.version)) {
    throw new Error(`packed package.json.name and .version must be strings`);
  }
  const dshValue = isRecord(value.dsh) ? value.dsh : undefined;
  if (dshValue === undefined) {
    return { name: value.name, version: value.version };
  }
  const bundleValue = isRecord(dshValue.bundle) ? dshValue.bundle : undefined;
  if (bundleValue === undefined) {
    return { name: value.name, version: value.version, dsh: {} };
  }
  if (!isString(bundleValue.patch)) {
    throw new Error(`packed package.json.dsh.bundle.patch must be a string`);
  }
  return {
    name: value.name,
    version: value.version,
    dsh: { bundle: { patch: bundleValue.patch } },
  };
}

/** Parse the spawned consumer process stdout. */
export function parseConsumerResult(value: unknown): ConsumerResult {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error(`consumer output must be an object with "ok": true`);
  }
  const root = isRecord(value.root) ? value.root : undefined;
  const client = isRecord(value.client) ? value.client : undefined;
  if (root === undefined) {
    throw new Error(`consumer output missing "root" object`);
  }
  if (client === undefined) {
    throw new Error(`consumer output missing "client" object`);
  }
  if (!isString(root.name) || !isString(root.route) || !isString(root.apiKeyEnv)) {
    throw new Error(`consumer output root contract fields must be strings`);
  }
  if (!isString(client.name) || !isString(client.providerRoute) || !isString(client.apiKeyEnv)) {
    throw new Error(`consumer output client contract fields must be strings`);
  }
  return {
    ok: true,
    root: { name: root.name, route: root.route, apiKeyEnv: root.apiKeyEnv },
    client: { name: client.name, providerRoute: client.providerRoute, apiKeyEnv: client.apiKeyEnv },
  };
}
