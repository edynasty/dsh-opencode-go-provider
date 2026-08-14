/**
 * Network source loading for the catalog generator CLI.
 *
 * `--network` fetches the full models.dev api.json provider map, selects only
 * the `opencode-go` record, and captures live ids through the provider's
 * models endpoint. The returned modelsDevJson is the selected provider RECORD
 * (not the full map) so generation can parse it as a single provider. Without
 * a nonempty OPENCODE_GO_API_KEY it fails closed before any network call; a
 * failed live capture also fails closed — fresh metadata is never mixed with
 * a synthetic or stale live fixture. No header, body or key material is ever
 * logged.
 */
import { parseJsonFile } from "../src/state-file.ts";
import { parseModelsDevApiJson } from "../src/models-dev.ts";
import { buildLiveModelsEndpoint } from "../src/urls.ts";
import { isCanonicalApiKey, isRecord } from "../src/guards.ts";
import { PROVIDER_ID } from "../src/types.ts";

export const MODELS_DEV_URL = "https://models.opencode.ai/api.json";
export const FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchText(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return response.text();
}

export interface NetworkSources {
  readonly modelsDevJson: string;
  readonly liveJson: string;
}

/**
 * Load models.dev (full api.json map) and the authenticated live ids payload.
 * Rejects when the API key is not canonical (nonempty, already trimmed, free
 * of whitespace/controls), when the map lacks a valid opencode-go record, when
 * the provider api is not a validated OpenCode Go endpoint, or when the live
 * capture fails. The credential is only ever sent to a validated
 * `https://opencode.ai/zen/go*` endpoint built through the URL API.
 */
export async function fetchNetworkSources(apiKey: string | undefined, fetchImpl: FetchLike = fetch): Promise<NetworkSources> {
  if (!isCanonicalApiKey(apiKey)) {
    throw new Error("--network requires a canonical OPENCODE_GO_API_KEY (nonempty, already trimmed, no whitespace or control characters); refusing to combine fresh metadata with synthetic availability");
  }
  const mapJson = await fetchText(MODELS_DEV_URL, fetchImpl);
  const map: unknown = parseJsonFile(mapJson, "models.dev");
  const provider = parseModelsDevApiJson(map);
  const record = isRecord(map) ? map[PROVIDER_ID] : undefined;
  if (!isRecord(record)) {
    throw new Error(`provider map has no "${PROVIDER_ID}" record`);
  }
  const endpoint = buildLiveModelsEndpoint(provider.api);
  if (endpoint === undefined) {
    throw new Error("opencode-go provider api is not a valid OpenCode Go base URL; refusing to send credentials");
  }
  const liveJson = await fetchText(endpoint, fetchImpl, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return { modelsDevJson: JSON.stringify(record), liveJson };
}
