/**
 * Host wiring for the OpenCode Go provider bundle row `llm-opencode-go`.
 *
 * Validation precedes registration, never the other way around: the composition
 * entry is checked with `assertServiceable` before anything else, and when a
 * settings service is already mounted its stored section is validated
 * synchronously through `SettingsProvider.register` BEFORE any route/directory
 * topology exists — `register` throws (and registers nothing) on an
 * unserviceable section, so the mount rejects with zero effects instead of
 * relying on the host's eventual rollback. With no settings service the
 * already-validated entry is authoritative. The adapter and route keep a
 * *current-source thunk*, so committed changes hot-apply through the dynamic
 * source while `ensureRegistration`/`ensureDirectory` perform atomic `replace`
 * swaps — never dispose-then-register — so no observer sees an empty interval.
 * Registrations ride the plugin fiber and are withdrawn by disposal.
 *
 * `installSettingsSection` is deliberately not used: it registers the scope
 * inside `ctx.inject`, whose failures are contained by the host and whose
 * dispatch is asynchronous, so it cannot act as the pre-registration gate.
 * The same wiring (source thunk, atomic replace, detach fallback) is
 * implemented here with public APIs so the gate is synchronous and observable.
 */
import { Context } from "@deepseek-ai/cordis";
import { deepEqualJson, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace, SettingsScope } from "@deepseek-ai/dsh-settings";
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from "@deepseek-ai/dsh-llm";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ROW_ID, DISPLAY_NAME, PROVIDER_ROUTE } from "./contract.ts";
import { Config, assertServiceable } from "./config.ts";
import type { Config as ConfigType, SectionInput } from "./config.ts";
import { resolveApiKey } from "./credentials.ts";
import { embeddedPatches } from "./catalog-loader.ts";
import { resolveCachePath, writeCacheAtomic } from "./cache.ts";
import { CatalogLifecycle } from "./lifecycle.ts";
import { nodeFetch } from "./sync.ts";
import type { Scheduler, SyncFetch } from "./sync.ts";
import { OpenCodeGoAdapter } from "./adapter.ts";

/**
 * Settings namespace owned by this provider; the bundle row id. Annotated with
 * the public `SettingsNamespace` brand type so the declaration rollup names the
 * public type instead of inlining its underlying representation.
 */
export const NS: SettingsNamespace = settingsNamespace(BUNDLE_ROW_ID);

/** The one configurable-provider directory entry: the whole section is the profile. */
export const DIRECTORY_ENTRY: LlmConfigurableProvider = {
  provider: PROVIDER_ROUTE,
  displayName: DISPLAY_NAME,
  settingsNs: NS,
  settingsPath: [],
  // This route is one of ours (we ship the catalog), never a user-added one.
  declared: false,
};

/** Config-derived fingerprint gating atomic re-registration. Never throws. */
function registrationFacts(config: ConfigType): unknown {
  return {
    routes: [PROVIDER_ROUTE],
    apiKeyEnv: config.apiKeyEnv,
    refreshMs: config.refreshMs,
    freshnessMs: config.freshnessMs,
    timeoutMs: config.timeoutMs,
    graceMs: config.graceMs,
  };
}

/**
 * Value mirror of the `FiberState` members compared below: a const enum has
 * no runtime object to import, so the values are needed at runtime (same
 * rationale as the settings package's own mirror).
 */
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;

/** The plugin fiber is unloading or already disposed: teardown is in progress. */
function isUnloading(ctx: Context): boolean {
  const state = ctx.fiber.state;
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}

/** Narrow a host-provided fetch (tests inject one); production falls back to nodeFetch. */
function isSyncFetchLike(value: unknown): value is SyncFetch {
  return typeof value === "function";
}

/** The network seam: a harness-provided fetch, or the real fetch adapter. */
function resolveHostFetch(ctx: Context): SyncFetch {
  const provided = ctx.get("opencodeGoFetch");
  return isSyncFetchLike(provided) ? provided : nodeFetch();
}

/** The cache home: a harness-provided path, else $DSH_HOME, else ~/.dsh. */
function resolveDshHome(ctx: Context): string {
  const provided = ctx.get("opencodeGoHome");
  if (typeof provided === "string" && provided.length > 0) return provided;
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Production scheduler: real timers, unref'd so they never hold the host open. */
function defaultScheduler(): Scheduler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      timers.set(id, timer);
      return { id };
    },
    clearTimer: (handle) => {
      const timer = timers.get(handle.id);
      if (timer !== undefined) {
        timers.delete(handle.id);
        clearTimeout(timer);
      }
    },
  };
}

/** Cordis plugin factory: mount the provider's reversible Host effects. */
export function apply(ctx: Context, rawConfig?: SectionInput): void {
  // Gate the composition entry BEFORE any registration side effect.
  const entry = Config(rawConfig ?? {});
  assertServiceable(entry);

  // The adapter and route keep a live source thunk, not a startup snapshot.
  let current: () => ConfigType = () => entry;
  // The SWR catalog lifecycle owns the served snapshot; its network, clock,
  // scheduler, cache home and credential seam are all injected so a harness
  // can fail-close the network and point the cache at a temp home.
  const lifecycle = new CatalogLifecycle({
    fetch: resolveHostFetch(ctx),
    resolveKey: (ref) => resolveApiKey(ctx, ref),
    currentConfig: () => current(),
    clock: { now: () => new Date() },
    scheduler: defaultScheduler(),
    cachePath: () => resolveCachePath(resolveDshHome(ctx)),
    patches: embeddedPatches(),
    persistCache: writeCacheAtomic,
  });
  const adapter = new OpenCodeGoAdapter({
    currentConfig: () => current(),
    resolveKey: (ref) => resolveApiKey(ctx, ref),
    catalog: () => lifecycle.catalog(),
    resolveAttachments: () => ctx.get("attachments"),
  });

  let directory: DirectoryRegistrationHandle | undefined;
  const ensureDirectory = (): void => {
    if (directory !== undefined) return;
    directory = ctx.llm.registerConfigurableProviders([DIRECTORY_ENTRY]);
  };

  let registration: AdapterRegistrationHandle | undefined;
  let registeredFacts: unknown;
  const ensureRegistration = (): void => {
    const facts = registrationFacts(current());
    if (deepEqualJson(facts, registeredFacts)) return;
    // The candidate route set is validated by the host before anything moves;
    // the swap is one synchronous section, so no request observes a gap.
    if (registration === undefined) {
      registration = ctx.llm.registerAdapter([PROVIDER_ROUTE], adapter);
    } else {
      registration.replace([PROVIDER_ROUTE]);
    }
    registeredFacts = facts;
  };

  /**
   * Make one validated scope authoritative: point the source thunk at it,
   * register topology, and re-judge topology on committed changes. Called
   * only after a successful registration, so the source is always
   * serviceable — validation is the gate, never a post-hoc filter.
   */
  const attachScope = (scope: SettingsScope<ConfigType>): void => {
    current = () => scope.get();
    ensureDirectory();
    ensureRegistration();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      ensureDirectory();
      ensureRegistration();
      lifecycle.notifyConfigChanged();
    });
  };

  const settings = ctx.get("settings");
  if (settings !== undefined) {
    // A settings service is mounted: the stored section must validate BEFORE
    // any route/directory topology exists. `register` resolves the stored
    // section through the schema and the validate hook synchronously and
    // registers nothing on failure, so the throw rejects the mount with zero
    // effects — no reliance on the host's eventual rollback.
    attachScope(settings.register(NS, Config, { base: entry, validate: assertServiceable }));
  } else {
    // No settings service mounted: serve from the already-validated entry.
    ensureDirectory();
    ensureRegistration();
  }

  // A settings service appearing after the mount (or detaching) re-judges the
  // source. The detach fallback rides the settings fiber; a stored section
  // that arrives unserviceable fails inside the host's inject (contained) and
  // the validated entry topology stays authoritative.
  ctx.inject(["settings"], (sctx) => {
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      current = () => entry;
      ensureDirectory();
      ensureRegistration();
      lifecycle.notifyConfigChanged();
    });
    if (sctx.settings.get(NS) === undefined) {
      attachScope(
        sctx.settings.register(NS, Config, { base: entry, validate: assertServiceable }),
      );
    }
  });

  // The lifecycle rides the plugin fiber: disposal stops scheduling, aborts
  // any active source pair and settles the single-flight. The disposer
  // returns the dispose promise so fiber teardown awaits it.
  ctx.effect(() => () => lifecycle.dispose());
  lifecycle.start();
}

/** Cordis service dependency: the plugin mounts only once `llm` is available. */
export const inject = ["llm"] as const;
