/**
 * DSH Host entrypoint for the OpenCode Go provider bundle.
 *
 * The bundle row `llm-opencode-go` (cordis.patch.yml) mounts this module as a
 * Cordis plugin. The plugin factory wires the provider's reversible Host
 * effects — settings namespace, per-operation credentials, the configurable-
 * provider directory and the owned adapter route — while this entry keeps the
 * stable contract values and the verified catalog machinery (reconciliation,
 * boundary parsers, deterministic renderers) available to consumers and tests.
 */
import { API_KEY_ENV, BUNDLE_ROW_ID, PLUGIN_NAME, PROVIDER_ROUTE } from "./contract.ts";
import { FOURTEEN_DAYS_MS } from "./constants.ts";
import { reconcile } from "./reconcile.ts";
import { parseLiveIds, parseModelsDevProvider, sdkToProtocol } from "./models-dev.ts";
import {
  compareIds,
  renderDeprecatedFile,
  renderModelsManifest,
  renderPatchesFile,
  renderQuarantineFile,
} from "./catalog.ts";
import {
  parseDeprecatedFile,
  parseJsonFile,
  parseModelsManifest,
  parsePatchesFile,
  parseQuarantineFile,
} from "./state-file.ts";
export { Config, DEFAULTS, assertServiceable, resolveConfig } from "./config.ts";
export { MISSING_CREDENTIAL_CODE, resolveApiKey, withResolvedKey } from "./credentials.ts";
export { embeddedCatalogModels } from "./catalog-loader.ts";
export { DISPLAY_NAME, NOT_IMPLEMENTED_CODE, PlaceholderAdapter } from "./placeholder-adapter.ts";
export { DIRECTORY_ENTRY, NS, apply, inject } from "./service.ts";

export type {
  CatalogModel,
  DeprecatedEntry,
  ModelCost,
  ModelsDevProvider,
  Patches,
  PreviousState,
  Protocol,
  QuarantineRecord,
  QuarantineReasonCode,
  QuarantineSource,
  ReconcileInput,
  ReconcileResult,
  ReconcileStats,
} from "./types.ts";
export type { Config as ConfigType, ResolvedConfig } from "./config.ts";
export { PROTOCOLS, PROVIDER_ID, QUARANTINE_REASON_CODES, QUARANTINE_SOURCES } from "./types.ts";
export { FOURTEEN_DAYS_MS, reconcile };
export { parseLiveIds, parseModelsDevProvider, sdkToProtocol };
export {
  compareIds,
  renderDeprecatedFile,
  renderModelsManifest,
  renderPatchesFile,
  renderQuarantineFile,
};
export {
  parseDeprecatedFile,
  parseJsonFile,
  parseModelsManifest,
  parsePatchesFile,
  parseQuarantineFile,
};

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
