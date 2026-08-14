/**
 * Narrow internal control seam for the OpenCode Go provider.
 *
 * One typed surface serves Host commands and the client Remote/API. Connect
 * accepts a key ONLY through the DSH credentials service (canonical validation
 * happens before any write and the key is never stored, echoed or returned
 * elsewhere); status reports configured plus lifecycle facts with no network;
 * doctor issues one authenticated GET /models; disconnect calls
 * `credentials.unset` only and is idempotent; migration delegates to the
 * structural settings migration. `standaloneControl` is the boot-free wiring
 * the CLI commands use: environment-backed read-only credentials, the embedded
 * catalog and the real fetch seam.
 */
import type { CredentialInfo, CredentialRef } from "@deepseek-ai/dsh-credentials";
import { assertUsableApiKey, LlmError } from "@deepseek-ai/dsh-llm";
import { embeddedCatalogModels } from "./catalog-loader.ts";
import { DEFAULTS, resolveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { BUNDLE_ROW_ID } from "./contract.ts";
import { MISSING_CREDENTIAL_CODE } from "./credentials.ts";
import { runDoctor } from "./doctor.ts";
import type { DoctorOutcome } from "./doctor.ts";
import { isCanonicalApiKey } from "./guards.ts";
import { applyMigration, dryRunMigration } from "./migration.ts";
import type { MigrationApply, MigrationApplyOptions, MigrationDryRun } from "./migration.ts";
import { defaultClock, defaultScheduler } from "./scheduler.ts";
import { buildStatus } from "./status.ts";
import type { LifecycleFacts, StatusResult } from "./status.ts";
import { nodeFetch } from "./sync.ts";
import type { Clock, Scheduler, SyncFetch } from "./sync.ts";
import type { CatalogModel } from "./types.ts";

/** The credential operations the control seam needs; nothing else is exposed. */
export interface CredentialStore {
  readonly describe: (ref: CredentialRef) => Promise<CredentialInfo>;
  readonly set: (ref: CredentialRef, value: string) => Promise<void>;
  readonly unset: (ref: CredentialRef) => Promise<void>;
}

/** Everything the control seam needs; every dependency is injectable. */
export interface ControlDeps {
  readonly credentials: CredentialStore;
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  readonly currentConfig: () => Config;
  readonly catalog: () => readonly CatalogModel[];
  readonly lifecycleFacts: () => LifecycleFacts;
  readonly fetch: SyncFetch;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
}

export type ConnectResult =
  | { readonly kind: "connected"; readonly ref: CredentialRef }
  | { readonly kind: "invalid"; readonly code: "INVALID_CREDENTIAL"; readonly message: string }
  | { readonly kind: "store-failed"; readonly message: string };

export type DisconnectResult =
  | { readonly kind: "disconnected"; readonly ref: CredentialRef }
  | { readonly kind: "store-failed"; readonly message: string };

function nonCanonicalMessage(): string {
  return `${BUNDLE_ROW_ID}: the API key is not canonical (it carries whitespace or control characters);`
    + " store the raw key alone — it is never trimmed or rewritten";
}

function unheaderableMessage(): string {
  return `${BUNDLE_ROW_ID}: the API key cannot be carried as an HTTP header; store the raw key alone`;
}

function notWritableMessage(): string {
  return `${BUNDLE_ROW_ID}: the credential store is not writable from this surface;`
    + " connect through the running Harness Host";
}

/**
 * The narrow typed surface consumed by Host commands, the client Remote/API
 * and the web card. The key never leaves the operation boundary.
 */
export class ProviderControl {
  constructor(private readonly deps: ControlDeps) {}

  /** Store one canonical key through the credentials service only. */
  async connect(key: string): Promise<ConnectResult> {
    const config = resolveConfig(this.deps.currentConfig());
    const described = await this.deps.credentials.describe(config.apiKeyEnv);
    if (!described.writable) {
      return { kind: "store-failed", message: notWritableMessage() };
    }
    if (!isCanonicalApiKey(key)) {
      return { kind: "invalid", code: "INVALID_CREDENTIAL", message: nonCanonicalMessage() };
    }
    let usable: string;
    try {
      usable = assertUsableApiKey(key, BUNDLE_ROW_ID, config.apiKeyEnv);
    } catch {
      return { kind: "invalid", code: "INVALID_CREDENTIAL", message: unheaderableMessage() };
    }
    try {
      await this.deps.credentials.set(config.apiKeyEnv, usable);
    } catch {
      return { kind: "store-failed", message: `${BUNDLE_ROW_ID}: the credential could not be stored` };
    }
    return { kind: "connected", ref: config.apiKeyEnv };
  }

  /** Report configured plus lifecycle facts; never touches the network. */
  async status(): Promise<StatusResult> {
    const config = resolveConfig(this.deps.currentConfig());
    const described = await this.deps.credentials.describe(config.apiKeyEnv);
    return buildStatus(described.configured, described.source, this.deps.lifecycleFacts());
  }

  /** One authenticated GET /models with the configured deadline. */
  doctor(signal?: AbortSignal): Promise<DoctorOutcome> {
    const config = resolveConfig(this.deps.currentConfig());
    return runDoctor({
      fetch: this.deps.fetch,
      resolveKey: this.deps.resolveKey,
      config,
      models: this.deps.catalog,
      clock: this.deps.clock,
      scheduler: this.deps.scheduler,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Idempotent: unsets the configured credential reference and nothing else. */
  async disconnect(): Promise<DisconnectResult> {
    const config = resolveConfig(this.deps.currentConfig());
    const described = await this.deps.credentials.describe(config.apiKeyEnv);
    if (!described.writable) {
      return { kind: "store-failed", message: notWritableMessage() };
    }
    try {
      await this.deps.credentials.unset(config.apiKeyEnv);
    } catch {
      return { kind: "store-failed", message: `${BUNDLE_ROW_ID}: the credential could not be removed` };
    }
    return { kind: "disconnected", ref: config.apiKeyEnv };
  }

  /** Structural legacy-config migration on a settings document path. */
  readonly migration: {
    readonly dryRun: (path: string) => Promise<MigrationDryRun>;
    readonly apply: (path: string, options?: MigrationApplyOptions) => Promise<MigrationApply>;
  } = {
    dryRun: (path) => dryRunMigration(path),
    apply: (path, options) => applyMigration(path, options),
  };
}

/** Read the launching environment's value for one reference (absent if empty). */
function environmentValue(ref: CredentialRef): string | undefined {
  const value = process.env[ref];
  return value !== undefined && value.length > 0 ? value : undefined;
}

const EPOCH_ISO = new Date(0).toISOString();

/**
 * Boot-free control wiring for the standalone CLI: environment-backed
 * read-only credentials, the embedded catalog, real clock/scheduler/fetch.
 * `set`/`unset` refuse because a standalone process must not write the DSH
 * credential store — that is the running Host's job.
 */
export function standaloneControl(): ProviderControl {
  return new ProviderControl({
    credentials: {
      describe: async (ref) => ({
        configured: environmentValue(ref) !== undefined,
        writable: false,
      }),
      set: async () => {
        throw new Error("the standalone command cannot write the DSH credential store");
      },
      unset: async () => {
        throw new Error("the standalone command cannot write the DSH credential store");
      },
    },
    resolveKey: async (ref) => {
      const value = environmentValue(ref);
      if (value === undefined) {
        throw new LlmError(
          `${BUNDLE_ROW_ID}: no credential for ${ref} in the launching environment`,
          MISSING_CREDENTIAL_CODE,
        );
      }
      if (!isCanonicalApiKey(value)) {
        throw new LlmError(`${BUNDLE_ROW_ID}: the API key in the environment is not canonical`, "INVALID_CREDENTIAL");
      }
      return value;
    },
    currentConfig: () => DEFAULTS,
    catalog: () => embeddedCatalogModels(),
    lifecycleFacts: () => ({
      origin: "embedded",
      modelCount: embeddedCatalogModels().length,
      refreshedAt: EPOCH_ISO,
      lastAttempt: { kind: "none" },
      attemptsSucceeded: 0,
      attemptsFailed: 0,
    }),
    fetch: nodeFetch(),
    clock: defaultClock(),
    scheduler: defaultScheduler(),
  });
}
