//#region src/contract.ts
/**
* Shared Host/Client contract values for the OpenCode Go provider bundle.
*
* Imported by both the Host entry (`src/index.ts`) and the Web client seam
* (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
* the values in one module prevents the Host and Client programs from
* drifting apart on the route, row, and credential names.
*/
/** Stable bundle/plugin name; must match package.json and the patch row. */
const PLUGIN_NAME = "dsh-opencode-go-provider";
/** DSH credentials environment variable resolved at operation time. */
const API_KEY_ENV = "OPENCODE_GO_API_KEY";
/** Provider route registered on ctx.llm and addressed by the settings card. */
const PROVIDER_ROUTE = "opencode-go";
//#endregion
//#region src/client/index.tsx
/**
* DSH Web client seam for the OpenCode Go settings card.
*
* The `./client` export is the browser half of the bundle. The visible Connect
* card, locale registration and slot injection are owned by a later todo; this
* module stays a typed, loadable seam exposing the stable client contract.
*/
/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
const name = `${PLUGIN_NAME}-client`;
/** Machine-consumed client contract surfaced by the `./client` entry. */
const clientContract = {
	name,
	providerRoute: PROVIDER_ROUTE,
	apiKeyEnv: API_KEY_ENV
};
//#endregion
export { clientContract, name };
