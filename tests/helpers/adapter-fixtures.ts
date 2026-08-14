/**
 * Shared fixtures for the Task 5 adapter wire specs.
 *
 * The real embedded catalog is the source of model metadata; tests only
 * override `baseUrl` to point at a loopback mock, so every transport, capacity
 * and reasoning fact comes from the shipped catalog. The collector mirrors the
 * `LlmRuntime` normalization (a thrown `LlmError` is a terminal outcome).
 */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/config.ts";
import { embeddedCatalogModels } from "../../src/catalog-loader.ts";
import { PROTOCOLS } from "../../src/types.ts";
import type { CatalogModel, Protocol } from "../../src/types.ts";
import type { MockContext } from "./mock-server.ts";
import { OpenCodeGoAdapter } from "../../src/adapter.ts";

/** Sanitized mock-wire evidence file (plan Task 5). */
export const WIRE_NDJSON_PATH = join(homedir(), ".omo", "evidence", "task-5-wire.ndjson");

/** Wrap a responder so every request it serves carries the protocol in the wire evidence. */
export function wireProtocol(
  protocol: Protocol,
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): (request: IncomingMessage, response: ServerResponse, context: MockContext) => void {
  return (request, response, context) => {
    context.setProtocol(protocol);
    respond(request, response);
  };
}

/** The shipped model id used as the fixture for each protocol. */
export const FIXTURE_MODELS: Readonly<Record<Protocol, string>> = {
  "openai-completions": "deepseek-v4-flash",
  "openai-responses": "gpt-5.6-luna",
  "anthropic-messages": "minimax-m2.5",
};

/** The shipped image-capable model id per protocol (image wire tests). */
export const IMAGE_MODELS: Readonly<Record<Protocol, string>> = {
  "openai-completions": "kimi-k2.5",
  "openai-responses": "grok-4.5",
  "anthropic-messages": "minimax-m3",
};

/** Fake API key used only inside the mock wire; never written to evidence. */
export const FAKE_KEY = "sk-task5-fake-wire-key-0123456789";

/** The shipped catalog entry for one protocol, with `baseUrl` pointed at the mock. */
export function catalogModelFor(
  protocol: Protocol,
  baseUrl: string,
  modelId: string = FIXTURE_MODELS[protocol],
): CatalogModel {
  const found = embeddedCatalogModels().find((entry) => entry.id === modelId);
  if (found === undefined) {
    throw new Error(`test setup: catalog has no model "${modelId}"`);
  }
  return { ...found, baseUrl };
}

/** A catalog thunk naming exactly one model per protocol, all on the mock. */
export function mockCatalog(baseUrl: string): readonly CatalogModel[] {
  return PROTOCOLS.map((protocol) => catalogModelFor(protocol, baseUrl));
}

/** Build the adapter under test with a deterministic per-operation config. */
export function makeAdapter(
  catalog: () => readonly CatalogModel[],
  options: { readonly timeoutMs?: number; readonly resolveAttachments?: () => AttachmentStore | undefined } = {},
): OpenCodeGoAdapter {
  return new OpenCodeGoAdapter({
    currentConfig: () =>
      Config({ apiKeyEnv: "OPENCODE_GO_API_KEY", ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
    resolveKey: () => Promise.resolve(FAKE_KEY),
    catalog,
    ...(options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments }),
  });
}

/** A user message fixture in the harness vocabulary. */
export function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

/** Run one generation request and normalize a thrown `LlmError` into the result. */
export interface Collected {
  readonly chunks: readonly StreamChunk[];
  readonly thrown: LlmError | undefined;
}

/**
 * Run one generation request and normalize a genuine `LlmError` into the
 * result. Any other thrown value is rethrown unchanged: a crash in the
 * provider/replay path must reject the collector, never masquerade as a clean
 * stream that satisfies `terminalCode(...) === undefined`.
 */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<Collected> {
  const chunks: StreamChunk[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { chunks, thrown: undefined };
  } catch (error) {
    if (error instanceof LlmError) return { chunks, thrown: error };
    throw error;
  }
}

/** The terminal error/aborted finish code, or undefined for a clean stream. */
export function terminalCode(collected: Collected): string | undefined {
  if (collected.thrown !== undefined) return collected.thrown.code;
  for (const chunk of collected.chunks) {
    if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
      return chunk.reason.failure.code;
    }
  }
  return undefined;
}

/** The single finish chunk's reason kind, or undefined. */
export function finishKind(collected: Collected): string | undefined {
  for (const chunk of collected.chunks) {
    if (chunk.type === "finish") return chunk.reason.kind;
  }
  return undefined;
}

/** Convenience re-export so specs name the collect helper once. */
export function optionsFor(model: string, extra?: Partial<GenerateOptions>): GenerateOptions {
  return { provider: "opencode-go", model, messages: [], ...extra };
}
