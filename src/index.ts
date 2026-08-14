/**
 * DSH Host entrypoint for the OpenCode Go provider bundle.
 *
 * The bundle row `llm-opencode-go` (cordis.patch.yml) mounts this module as a
 * Cordis plugin. Host service registration — settings namespace, credential
 * resolution, the multi-protocol adapter and catalog sync — is owned by later
 * contract todos; this entry stays a typed, loadable seam that exposes the
 * provider's stable contract values to consumers and tests.
 */
import type { Context } from "@deepseek-ai/cordis";
import { API_KEY_ENV, BUNDLE_ROW_ID, PLUGIN_NAME, PROVIDER_ROUTE } from "./contract.ts";

/** Stable plugin name, must match the patch row and package.json. */
export const name = PLUGIN_NAME;

export const apiKeyEnv = API_KEY_ENV;
export const bundleRowId = BUNDLE_ROW_ID;
export const providerRoute = PROVIDER_ROUTE;

export interface ProviderDescriptor {
  readonly name: typeof PLUGIN_NAME;
  readonly route: typeof PROVIDER_ROUTE;
  readonly bundleRow: typeof BUNDLE_ROW_ID;
  readonly apiKeyEnv: typeof API_KEY_ENV;
}

/** Machine-consumed provider contract surfaced by the Host entry. */
export const provider: ProviderDescriptor = {
  name: PLUGIN_NAME,
  route: PROVIDER_ROUTE,
  bundleRow: BUNDLE_ROW_ID,
  apiKeyEnv: API_KEY_ENV,
};

/**
 * Cordis plugin factory. Later todos register the provider's reversible
 * effects (settings namespace, credentials, adapter, catalog sync) on this
 * context; the row stays mountable and typed in the meantime.
 */
export function apply(ctx: Context): void {
  void ctx;
}
