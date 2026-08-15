/** Typed declaration for the shared repository credential scan
 * (`scripts/scan-secrets.mjs`). Exact match to the implementation: `scanRepo`
 * returns a string-array of formatted `relative-path category` hits and a
 * numeric enumerated-file count. */

export interface SecretPattern {
  readonly category: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[];
export const ALLOWED_FIXTURES: Readonly<Record<string, readonly string[]>>;

export function sha256Hex(value: string): string;
export function formatHit(file: string, category: string): string;
export function safePath(path: string): string;
export function scanContent(
  content: string,
  file: string,
  allowedDigests?: readonly string[],
  patterns?: readonly SecretPattern[],
): readonly string[];
export function enumerateRepoFiles(root: string): string[];
export function scanFileEntry(
  file: string,
  root: string,
  allowedFixtures?: Readonly<Record<string, readonly string[]>>,
): readonly string[];
export function scanRepo(
  root: string,
): { hits: readonly string[]; files: number };
