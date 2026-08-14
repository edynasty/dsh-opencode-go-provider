import { Context } from "@deepseek-ai/cordis";
//#region src/contract.d.ts
/**
 * Shared Host/Client contract values for the OpenCode Go provider bundle.
 *
 * Imported by both the Host entry (`src/index.ts`) and the Web client seam
 * (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
 * the values in one module prevents the Host and Client programs from
 * drifting apart on the route, row, and credential names.
 */
/** Stable bundle/plugin name; must match package.json and the patch row. */
declare const PLUGIN_NAME: "dsh-opencode-go-provider";
/** DSH credentials environment variable resolved at operation time. */
declare const API_KEY_ENV: "OPENCODE_GO_API_KEY";
/** Bundle row id inserted by cordis.patch.yml. */
declare const BUNDLE_ROW_ID: "llm-opencode-go";
/** Provider route registered on ctx.llm and addressed by the settings card. */
declare const PROVIDER_ROUTE: "opencode-go";
//#endregion
//#region src/index.d.ts
/** Stable plugin name, must match the patch row and package.json. */
declare const name: "dsh-opencode-go-provider";
declare const apiKeyEnv: "OPENCODE_GO_API_KEY";
declare const bundleRowId: "llm-opencode-go";
declare const providerRoute: "opencode-go";
interface ProviderDescriptor {
  readonly name: typeof PLUGIN_NAME;
  readonly route: typeof PROVIDER_ROUTE;
  readonly bundleRow: typeof BUNDLE_ROW_ID;
  readonly apiKeyEnv: typeof API_KEY_ENV;
}
/** Machine-consumed provider contract surfaced by the Host entry. */
declare const provider: ProviderDescriptor;
/**
 * Cordis plugin factory. Later todos register the provider's reversible
 * effects (settings namespace, credentials, adapter, catalog sync) on this
 * context; the row stays mountable and typed in the meantime.
 */
declare function apply(ctx: Context): void;
//#endregion
export { ProviderDescriptor, apiKeyEnv, apply, bundleRowId, name, provider, providerRoute };