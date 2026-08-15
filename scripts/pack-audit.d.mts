/** Typed declaration for the shared packed-bytes audit (`pack-audit.mjs`). */
export interface TarballAudit {
  readonly packedPaths: readonly string[];
  readonly allowlistViolations: readonly string[];
  readonly archiveViolations: readonly string[];
  readonly missingRequired: readonly string[];
  readonly controlChunkViolations: readonly string[];
  readonly secretHits: readonly string[];
  readonly pathHits: readonly string[];
  readonly privateImportHits: readonly string[];
  readonly specialEntries: readonly string[];
}

export function isAllowedPath(path: string): boolean;
export function auditTarball(tarball: string, workDir: string): Promise<TarballAudit>;
export function assertAuditClean(audit: TarballAudit): void;
