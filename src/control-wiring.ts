/**
 * Host wiring for the provider control seam.
 *
 * `trackLifecycleEvents` records the sanitized last-refresh attempt fact from
 * the lifecycle's observable events; `mountControl` constructs the typed
 * `ProviderControl` with live context-provided credentials and lifecycle facts
 * and provides it on the plugin fiber, so Host commands, the client
 * Remote/API and tests resolve one seam and disposal withdraws it with the
 * plugin.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { ProviderControl } from "./control.ts";
import type { Config } from "./config.ts";
import type { CatalogLifecycle } from "./lifecycle.ts";
import type { LifecycleEvent } from "./lifecycle-contract.ts";
import type { LifecycleFacts, StatusLastAttempt } from "./status.ts";
import type { Scheduler, SyncFetch } from "./sync.ts";

/** Everything `mountControl` needs from the plugin composition site. */
export interface ControlMountDeps {
  readonly lifecycle: CatalogLifecycle;
  readonly tracker: { readonly lastAttempt: () => StatusLastAttempt };
  readonly current: () => Config;
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  readonly fetch: SyncFetch;
  readonly scheduler: Scheduler;
}

/** Observe the lifecycle's sanitized events and recall the last attempt fact. */
export function trackLifecycleEvents(): {
  readonly observe: (event: LifecycleEvent) => void;
  readonly lastAttempt: () => StatusLastAttempt;
} {
  let last: StatusLastAttempt = { kind: "none" };
  return {
    observe: (event) => {
      if (event.kind === "refresh-ok") {
        last = { kind: "ok" };
      } else if (event.kind === "refresh-failed") {
        last = { kind: "failed", code: event.code };
      }
    },
    lastAttempt: () => last,
  };
}

/** Read the lifecycle's current sanitized facts into a detached snapshot input. */
export function lifecycleFactsOf(
  lifecycle: CatalogLifecycle,
  lastAttempt: StatusLastAttempt,
): LifecycleFacts {
  return {
    origin: lifecycle.current().origin,
    modelCount: lifecycle.current().catalog.length,
    refreshedAt: lifecycle.current().refreshedAt,
    lastAttempt,
    attemptsSucceeded: lifecycle.stats.attemptsSucceeded,
    attemptsFailed: lifecycle.stats.attemptsFailed,
  };
}

/**
 * Build the control seam and provide it on the current (plugin) fiber. The
 * credentials store is context-derived: an absent service refuses writes and
 * reports unconfigured, mirroring the per-operation credential policy.
 */
export function mountControl(ctx: Context, deps: ControlMountDeps): ProviderControl {
  const credentials = ctx.get("credentials");
  const control = new ProviderControl({
    credentials: {
      describe: (ref) =>
        credentials !== undefined
          ? credentials.describe(ref)
          : Promise.resolve({ configured: false, writable: false }),
      set: (ref, value) =>
        credentials !== undefined
          ? credentials.set(ref, value)
          : Promise.reject(new Error("the credentials service is not mounted")),
      unset: (ref) =>
        credentials !== undefined
          ? credentials.unset(ref)
          : Promise.reject(new Error("the credentials service is not mounted")),
    },
    resolveKey: deps.resolveKey,
    currentConfig: deps.current,
    catalog: () => deps.lifecycle.catalog(),
    lifecycleFacts: () => lifecycleFactsOf(deps.lifecycle, deps.tracker.lastAttempt()),
    fetch: deps.fetch,
    clock: { now: () => new Date() },
    scheduler: deps.scheduler,
  });
  ctx.provide("opencodeGoControl", control);
  return control;
}
