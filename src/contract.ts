/**
 * Shared Host/Client contract values for the OpenCode Go provider bundle.
 *
 * Imported by both the Host entry (`src/index.ts`) and the Web client seam
 * (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
 * the values in one module prevents the Host and Client programs from
 * drifting apart on the route, row, and credential names.
 */

/** Stable bundle/plugin name; must match package.json and the patch row. */
export const PLUGIN_NAME = "dsh-opencode-go-provider" as const;

/** DSH credentials environment variable resolved at operation time. */
export const API_KEY_ENV = "OPENCODE_GO_API_KEY" as const;

/** Bundle row id inserted by cordis.patch.yml. */
export const BUNDLE_ROW_ID = "llm-opencode-go" as const;

/** Provider route registered on ctx.llm and addressed by the settings card. */
export const PROVIDER_ROUTE = "opencode-go" as const;

/** Display name served by the provider directory and selectors. */
export const DISPLAY_NAME = "OpenCode Go" as const;
