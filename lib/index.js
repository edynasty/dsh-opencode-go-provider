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
/** Bundle row id inserted by cordis.patch.yml. */
const BUNDLE_ROW_ID = "llm-opencode-go";
/** Provider route registered on ctx.llm and addressed by the settings card. */
const PROVIDER_ROUTE = "opencode-go";
//#endregion
//#region src/index.ts
/** Stable plugin name, must match the patch row and package.json. */
const name = PLUGIN_NAME;
const apiKeyEnv = API_KEY_ENV;
const bundleRowId = BUNDLE_ROW_ID;
const providerRoute = PROVIDER_ROUTE;
/** Machine-consumed provider contract surfaced by the Host entry. */
const provider = {
	name: PLUGIN_NAME,
	route: PROVIDER_ROUTE,
	bundleRow: BUNDLE_ROW_ID,
	apiKeyEnv: API_KEY_ENV
};
/**
* Cordis plugin factory. Later todos register the provider's reversible
* effects (settings namespace, credentials, adapter, catalog sync) on this
* context; the row stays mountable and typed in the meantime.
*/
function apply(ctx) {}
//#endregion
export { apiKeyEnv, apply, bundleRowId, name, provider, providerRoute };
