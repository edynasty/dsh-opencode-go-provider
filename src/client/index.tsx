/**
 * DSH Web client seam for the OpenCode Go settings card.
 *
 * The `./client` export is the browser half of the bundle. The visible Connect
 * card, locale registration and slot injection are owned by a later todo; this
 * module stays a typed, loadable seam exposing the stable client contract.
 */
import { API_KEY_ENV, PLUGIN_NAME, PROVIDER_ROUTE } from "../contract.ts";

/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
export const name = `${PLUGIN_NAME}-client` as const;

export interface ClientContract {
  readonly name: typeof name;
  readonly providerRoute: typeof PROVIDER_ROUTE;
  readonly apiKeyEnv: typeof API_KEY_ENV;
}

/** Machine-consumed client contract surfaced by the `./client` entry. */
export const clientContract: ClientContract = {
  name,
  providerRoute: PROVIDER_ROUTE,
  apiKeyEnv: API_KEY_ENV,
};
