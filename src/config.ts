/**
 * Configuration schema and per-operation snapshot for the OpenCode Go
 * provider.
 *
 * The schema owns per-field validation (intervals are positive finite
 * integers within the timer bound; `apiKeyEnv` is marked as a credential
 * reference position so redaction covers it); `assertServiceable` owns the
 * constraints the schema cannot express — the exact key set (a literal key
 * or custom header is an unknown key and is refused), the cross-field
 * invariants, and the POSIX reference shape; `resolveConfig` detaches and
 * freezes the per-operation snapshot with the reference branded through the
 * public `credentialRef` helper.
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { BUNDLE_ROW_ID } from "./contract.ts";

/** Schema-surface configuration: the composition entry and settings section. */
export interface Config {
  /** Credential reference (environment-variable name) resolved per operation. */
  apiKeyEnv: string;
  /** Catalog refresh interval in milliseconds. */
  refreshMs: number;
  /** Freshness window in milliseconds: within it a catalog is reused as-is. */
  freshnessMs: number;
  /** Per-operation network timeout in milliseconds. */
  timeoutMs: number;
  /** Grace period before a missing model is evicted, in milliseconds. */
  graceMs: number;
}

/**
 * Raw composition entry or settings section as a host hands it to the plugin:
 * any partial section, with arbitrary extra keys that the schema merges and
 * {@link assertServiceable} refuses. No `any`: unknown values stay `unknown`
 * until the schema call narrows them.
 */
export type SectionInput = Partial<Config> & Record<string, unknown>;

/** Canonical defaults: 60-minute refresh, 5-minute freshness, 10s timeout, 14-day grace. */
export const DEFAULTS = {
  apiKeyEnv: "OPENCODE_GO_API_KEY",
  refreshMs: 3_600_000,
  freshnessMs: 300_000,
  timeoutMs: 10_000,
  graceMs: 1_209_600_000,
} as const;

/** The exact declared key set; anything else is refused by assertServiceable. */
const CONFIG_KEYS = [
  "apiKeyEnv",
  "refreshMs",
  "freshnessMs",
  "timeoutMs",
  "graceMs",
] as const;

/** Per-operation snapshot with a branded credential reference; frozen and detached. */
export interface ResolvedConfig {
  readonly apiKeyEnv: ReturnType<typeof credentialRef>;
  readonly refreshMs: number;
  readonly freshnessMs: number;
  readonly timeoutMs: number;
  readonly graceMs: number;
}

const interval = (defaultMs: number) =>
  z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(defaultMs);

/**
 * Schemastery schema resolving the section; defaults fill an empty section.
 * The input shape is the section (all fields optional), the output shape is
 * {@link Config} (defaults materialized). Unknown keys are preserved by
 * schemastery's object merge and refused by {@link assertServiceable}.
 */
export const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULTS.apiKeyEnv),
  refreshMs: interval(DEFAULTS.refreshMs),
  freshnessMs: interval(DEFAULTS.freshnessMs),
  timeoutMs: interval(DEFAULTS.timeoutMs),
  graceMs: interval(DEFAULTS.graceMs),
});

/**
 * Refuse a resolved section this provider could not act on. Registered as the
 * settings namespace's validator, so an unserviceable section is refused where
 * it is written instead of being stored and silently breaking the operation.
 * The error message never echoes any value — only the offending key name.
 * @param config - the schema-resolved section.
 * @throws Error naming the offending key.
 */
export function assertServiceable(config: Config): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.some((declared) => declared === key)) {
      throw new Error(`${BUNDLE_ROW_ID}: configuration key "${key}" is not supported and was refused`);
    }
  }
  if (config.freshnessMs > config.refreshMs) {
    throw new Error(`${BUNDLE_ROW_ID}: freshnessMs (${config.freshnessMs}) must not exceed refreshMs (${config.refreshMs})`);
  }
  if (config.timeoutMs > config.refreshMs) {
    throw new Error(`${BUNDLE_ROW_ID}: timeoutMs (${config.timeoutMs}) must not exceed refreshMs (${config.refreshMs})`);
  }
  try {
    credentialRef(config.apiKeyEnv);
  } catch {
    throw new Error(
      `${BUNDLE_ROW_ID}: apiKeyEnv must be a credential reference (a POSIX shell identifier such as OPENCODE_GO_API_KEY)`,
    );
  }
}

/**
 * Detach a frozen per-operation snapshot from a schema-resolved section.
 * Branding happens here, once per operation, through the public
 * `credentialRef` helper — the section keeps a plain string so configuration
 * surfaces render it as a text field.
 * @param raw - the schema-resolved section.
 * @returns a frozen, detached snapshot safe to hand across module boundaries.
 */
export function resolveConfig(raw: Config): ResolvedConfig {
  assertServiceable(raw);
  return Object.freeze({
    apiKeyEnv: credentialRef(raw.apiKeyEnv),
    refreshMs: raw.refreshMs,
    freshnessMs: raw.freshnessMs,
    timeoutMs: raw.timeoutMs,
    graceMs: raw.graceMs,
  });
}
