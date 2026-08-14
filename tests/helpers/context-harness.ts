/**
 * Task 4 test harness: real Cordis `Context` plus an in-memory credentials
 * provider, an in-memory settings provider, and the real `LlmRuntime` from
 * `@deepseek-ai/dsh-llm`. The plugin under test (`src/service.ts`) is mounted
 * with `ctx.plugin`, so adapter/directory registration, atomic `replace`,
 * disposal and duplicate-ownership behavior run against the actual host
 * contract instead of a mock.
 *
 * No unsafe casts anywhere in this file: the settings provider is returned as
 * its public `SettingsProvider` type, credentials are concrete instances the
 * harness constructs itself, and the launch-environment double narrows its
 * values at runtime.
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { CredentialInfo, CredentialRef, ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { LlmAdapter, LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import type { SectionInput } from "../../src/config.ts";
import { apply } from "../../src/service.ts";

/** In-memory `CredentialProvider` double. Empty values are rejected at set. */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>();

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref);
    return value === undefined
      ? Promise.resolve(undefined)
      : Promise.resolve({ value, source: "file" });
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.store.has(ref), writable: true });
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) throw new Error(`credentials: refusing to store an empty value for ${ref}`);
    this.store.set(ref, value);
    return Promise.resolve();
  }

  unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref);
    return Promise.resolve();
  }
}

/**
 * In-memory `SettingsProvider` double: the base class owns resolve/update, the
 * double owns the document. The document object is the SAME reference the test
 * passed in, so a regression can repair a stored section in place.
 */
export class MemorySettings extends SettingsProvider {
  readonly writable = true;
  private readonly storage: Record<string, unknown>;

  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx);
    this.storage = doc;
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.storage);
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storage[ns] = { ...section };
    return Promise.resolve();
  }
}

/** Launch-environment snapshot double exposing a fixed value map. */
export interface FakeLaunchEnvironment {
  get(name: string): { readonly value: string; readonly source: string } | undefined;
  getFrom(
    name: string,
    _sources: readonly string[],
  ): { readonly value: string; readonly source: string } | undefined;
}

/** Build a launch-environment double whose values are narrowed at runtime. */
export function fakeLaunchEnvironment(
  values: Readonly<Record<string, string>>,
): FakeLaunchEnvironment {
  return {
    get: (name) => {
      const value = values[name];
      return typeof value === "string" ? { value, source: "process" } : undefined;
    },
    getFrom: (name) => {
      const value = values[name];
      return typeof value === "string" ? { value, source: "process" } : undefined;
    },
  };
}

/** Minimal foreign adapter used to prove unrelated routes survive disposal. */
export class ForeignAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: provider };
  }

  async *stream(_options: GenerateOptions): AsyncIterable<never> {
    yield* [];
  }
}

export interface BootServicesOptions {
  readonly config?: SectionInput;
  readonly settingsDoc?: Record<string, unknown>;
  readonly withSettings?: boolean;
  readonly withCredentials?: boolean;
  readonly launchEnvironment?: FakeLaunchEnvironment;
}

export interface BootServicesResult {
  readonly ctx: Context;
  readonly credentials: MemoryCredentials | undefined;
  readonly settings: SettingsProvider | undefined;
  readonly settingsFiber: Fiber | undefined;
  readonly llm: LlmRuntime;
}

/** Mount the host services (and nothing else) on a real Cordis context. */
export async function bootServices(options: BootServicesOptions = {}): Promise<BootServicesResult> {
  const ctx = new Context();
  const credentials = options.withCredentials === false ? undefined : new MemoryCredentials(ctx);
  const llm = new LlmRuntime(ctx);
  let settings: SettingsProvider | undefined;
  let settingsFiber: Fiber | undefined;
  if (options.withSettings !== false) {
    settingsFiber = await ctx.plugin(MemorySettings, options.settingsDoc ?? {});
    settings = ctx.get("settings");
  }
  if (options.launchEnvironment !== undefined) {
    ctx.provide("launchEnvironment", options.launchEnvironment);
  }
  return { ctx, credentials, settings, settingsFiber, llm };
}

/** Mount the plugin under test and return its fiber (caller settles it). */
export function mountPlugin(
  ctx: Context,
  config?: SectionInput,
): Fiber & PromiseLike<Fiber> {
  return ctx.plugin(apply, config);
}

export interface BootResult extends BootServicesResult {
  readonly fiber: Fiber & PromiseLike<Fiber>;
}

/** Mount host services and the plugin, awaiting a successful mount. */
export async function boot(options: BootServicesOptions = {}): Promise<BootResult> {
  const services = await bootServices(options);
  const fiber = mountPlugin(services.ctx, options.config);
  await fiber;
  return { ...services, fiber };
}

/** Safe getter: narrow the optional credentials service or fail the test setup. */
export function requireCredentials(harness: Pick<BootServicesResult, "credentials">): MemoryCredentials {
  if (harness.credentials === undefined) {
    throw new Error("test setup: credentials service was not mounted");
  }
  return harness.credentials;
}

/** Safe getter: narrow the optional settings service or fail the test setup. */
export function requireSettings(harness: Pick<BootServicesResult, "settings">): SettingsProvider {
  if (harness.settings === undefined) {
    throw new Error("test setup: settings service was not mounted");
  }
  return harness.settings;
}

/** Flush the settings watcher queue (Cordis watchers run on a later task). */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Record how many times the registry announced a topology change. */
export function countTopologyAnnouncements(ctx: Context): { readonly count: () => number } {
  let announced = 0;
  ctx.on("llm/adapters-updated", () => {
    announced += 1;
  });
  return { count: () => announced };
}

/**
 * Collect the terminal error codes a generation stream produces. The default
 * model is a shipped catalog entry: the harness resolves exact model metadata
 * before the adapter streams, so the credential-gate tests need a resolvable
 * model, while `extra` lets a test force a pre-network outcome.
 */
export async function streamCodes(
  llm: LlmRuntime,
  extra?: Partial<Pick<GenerateOptions, "model" | "signal" | "messages">>,
): Promise<readonly string[]> {
  const codes: string[] = [];
  for await (const chunk of llm.stream({
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    messages: [],
    ...extra,
  })) {
    if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
      codes.push(chunk.reason.failure.code);
    }
  }
  return codes;
}
