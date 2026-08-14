/**
 * Construction of the pi-ai `Provider` that backs the `opencode-go` route.
 *
 * The wire protocol is selected per model strictly from the catalog entry's
 * `api` field: `createProvider` dispatches on `model.api` through the protocol
 * table, so a model reaches exactly the transport its catalog metadata names —
 * no id prefixes, no provider-name heuristics, no endpoint probing.
 *
 * Credentials never enter this module's storage. The harness resolves the
 * route's key through its own seam and hands it over as a per-request stream
 * option, which pi-ai treats as the highest-priority auth override.
 */
import { createProvider, type Provider } from "@earendil-works/pi-ai";
import type { ApiKeyAuth, Model } from "@earendil-works/pi-ai";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { DISPLAY_NAME, PROVIDER_ROUTE } from "./contract.ts";
import { UNSUPPORTED_PROTOCOL, llmError } from "./errors.ts";
import type { CatalogModel, ModalityLiteral, Protocol } from "./types.ts";

/** The one protocol table: catalog `api` values to pi-ai API implementations. */
const PROTOCOLS: Readonly<Record<Protocol, ProviderStreams>> = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
};

/** Zero rates for a catalog entry that carries no cost metadata. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Narrow catalog modalities to the pi-ai vocabulary, text as the floor. */
function toPiInput(input: readonly ModalityLiteral[] | undefined): ("text" | "image")[] {
  const narrowed = (input ?? []).filter(
    (modality): modality is "text" | "image" =>
      modality === "text" || modality === "image",
  );
  return narrowed.length === 0 ? ["text"] : [...narrowed];
}

/** Map catalog pricing into the pi-ai cost shape (tiers translate threshold → inputTokensAbove). */
function toPiCost(cost: CatalogModel["cost"]): Model<Protocol>["cost"] {
  if (cost === undefined) return { ...NO_COST };
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tiers === undefined
      ? {}
      : {
          tiers: cost.tiers.map((tier) => ({
            input: tier.input,
            output: tier.output,
            cacheRead: tier.cacheRead ?? 0,
            cacheWrite: tier.cacheWrite ?? 0,
            inputTokensAbove: tier.threshold,
          })),
        }),
  };
}

/** Project one embedded catalog entry into the pi-ai model vocabulary. */
export function toPiModel(model: CatalogModel): Model<Protocol> {
  return {
    id: model.id,
    name: model.name,
    api: model.protocol,
    provider: PROVIDER_ROUTE,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: toPiInput(model.input),
    cost: toPiCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Api-key auth for a route the harness authenticates itself. pi-ai calls this
 * after the adapter has already resolved the route's credential, so the key
 * arrives in the per-request credential, never in provider storage.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: name,
      }),
  };
}

/**
 * Build the single-route pi-ai provider from the embedded catalog. Protocol
 * dispatch is entirely per-model `api`, so the catalog metadata is the sole
 * transport selector; a catalog entry naming a protocol this bundle cannot
 * serve fails at build time with a stable typed code.
 * @param models - the embedded catalog entries.
 * @returns the provider to register in the adapter's `Models` collection.
 */
export function buildProvider(models: readonly CatalogModel[]): Provider {
  for (const model of models) {
    if (PROTOCOLS[model.protocol] === undefined) {
      throw llmError(
        `opencode-go catalog entry "${model.id}" names protocol "${model.protocol}", which this bundle cannot serve`,
        UNSUPPORTED_PROTOCOL,
      );
    }
  }
  return createProvider({
    id: PROVIDER_ROUTE,
    name: DISPLAY_NAME,
    auth: { apiKey: harnessApiKeyAuth(DISPLAY_NAME) },
    models: models.map(toPiModel),
    api: PROTOCOLS,
  });
}
