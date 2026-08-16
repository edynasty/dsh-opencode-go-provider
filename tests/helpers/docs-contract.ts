/**
 * Docs-contract validator (Plan Task 9).
 *
 * QA tooling only: given a repository root, reads the bilingual README pair,
 * SECURITY.md, CONTRIBUTING.md and THIRD_PARTY_NOTICES.md and returns
 * machine-readable contract violations. Never shipped — the tarball `files`
 * allowlist excludes `tests/`, and no production code imports this module.
 *
 * The contract pins the exact tokens a downstream consumer or safety reviewer
 * would grep for: the commit-pinned install command, the credential boundary,
 * the three protocols, cache/grace facts, the non-affiliation statement and
 * the npm-unpublished status. Each violation names the file and the missing
 * or forbidden token so failures are actionable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PINNED_SHA = "d2a447610a5dff4006ac966525effd9669342a78";
export const GIT_SPEC = `github:edynasty/dsh-opencode-go-provider#${PINNED_SHA}`;
export const CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
export const ROUTE = "opencode-go";
export const PROTOCOLS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
] as const;

/** Forbidden availability claims: npm install must never be presented as a
 * supported installation path. */
const NPM_INSTALL_CLAIM = /npm\s+(?:i|install)\s+dsh-opencode-go-provider/;

function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function requireToken(
  text: string,
  token: string,
  label: string,
  errors: string[],
): void {
  if (!text.toLowerCase().includes(token.toLowerCase())) {
    errors.push(`missing ${label} token "${token}"`);
  }
}

/** Case-insensitive timing contract matcher: "5 minutes", "5-minute", "5 分钟". */
function requireTiming(
  text: string,
  number: string,
  unit: string,
  label: string,
  errors: string[],
): void {
  const pattern = new RegExp(`${number}[- ]?${unit}s?`, "iu");
  if (!pattern.test(text)) {
    errors.push(`missing ${label} token "${number} ${unit}"`);
  }
}

function forbidClaim(
  text: string,
  pattern: RegExp,
  label: string,
  errors: string[],
): void {
  if (pattern.test(text)) {
    errors.push(`forbidden ${label} claim matches /${pattern.source}/`);
  }
}

/**
 * Validate the bilingual docs contract of a repository root. Returns a list of
 * violations; an empty list means the docs satisfy the contract.
 */
export function validateDocsContract(rootDir: string): readonly string[] {
  const errors: string[] = [];

  const readmeEn = readText(join(rootDir, "README.md"));
  const readmeZh = readText(join(rootDir, "README.zh.md"));
  const security = readText(join(rootDir, "SECURITY.md"));
  const contributing = readText(join(rootDir, "CONTRIBUTING.md"));
  const notices = readText(join(rootDir, "THIRD_PARTY_NOTICES.md"));

  if (readmeEn === undefined) errors.push("missing file README.md");
  if (readmeZh === undefined) errors.push("missing file README.zh.md");
  if (security === undefined) errors.push("missing file SECURITY.md");
  if (contributing === undefined) errors.push("missing file CONTRIBUTING.md");
  if (notices === undefined) errors.push("missing file THIRD_PARTY_NOTICES.md");

  if (readmeEn !== undefined) validateEnglishReadme(readmeEn, errors);
  if (readmeZh !== undefined) validateChineseReadme(readmeZh, errors);
  if (security !== undefined) validateSecurity(security, errors);
  if (contributing !== undefined) validateContributing(contributing, errors);
  if (notices !== undefined) validateNotices(notices, errors);

  return errors;
}

function validateEnglishReadme(text: string, errors: string[]): void {
  // Installation: the commit-pinned Git install and uninstall commands.
  requireToken(text, GIT_SPEC, "README.md git-install spec", errors);
  requireToken(
    text,
    `dsh plugin --profile web add ${GIT_SPEC}`,
    "README.md install command",
    errors,
  );
  requireToken(
    text,
    "dsh plugin --profile web remove dsh-opencode-go-provider",
    "README.md uninstall command",
    errors,
  );
  requireToken(text, "not published", "README.md npm-unpublished status", errors);
  forbidClaim(text, NPM_INSTALL_CLAIM, "README.md npm-install availability", errors);

  // Non-affiliation statement.
  requireToken(text, "not affiliated", "README.md non-affiliation", errors);
  requireToken(text, "DeepSeek", "README.md non-affiliation DeepSeek", errors);
  requireToken(text, "OpenCode", "README.md non-affiliation OpenCode", errors);

  // Credential boundary.
  requireToken(text, CREDENTIAL_REF, "README.md credential ref", errors);
  requireToken(
    text,
    "operation time",
    "README.md credential resolution timing",
    errors,
  );
  requireToken(text, ROUTE, "README.md route", errors);

  // The three metadata-selected protocols, and no prefix guessing.
  for (const protocol of PROTOCOLS) {
    requireToken(text, protocol, "README.md protocol", errors);
  }
  requireToken(
    text,
    "prefix",
    "README.md no-prefix-guessing statement",
    errors,
  );

  // DSH compatibility, Node engines, pnpm version.
  requireToken(text, "rc.6", "README.md DSH rc.6 compatibility", errors);
  requireToken(text, "22.19", "README.md Node engine floor", errors);
  requireToken(text, "11.7.0", "README.md pnpm version", errors);

  // Catalog / cache / SWR / grace facts.
  requireToken(text, "models.dev", "README.md models.dev metadata", errors);
  requireToken(text, "stale-while-revalidate", "README.md SWR", errors);
  requireTiming(text, "5", "minute", "README.md freshness", errors);
  requireTiming(text, "60", "minute", "README.md refresh interval", errors);
  requireTiming(text, "10", "second", "README.md network timeout", errors);
  requireToken(text, "atomic", "README.md atomic cache", errors);
  requireToken(text, "offline", "README.md offline fallback", errors);
  requireToken(text, "quarantine", "README.md quarantine", errors);
  requireToken(text, "14-day", "README.md deprecated grace", errors);

  // Commands and behaviors.
  requireToken(text, "connect", "README.md connect", errors);
  requireToken(text, "status", "README.md status", errors);
  requireToken(text, "doctor", "README.md doctor", errors);
  requireToken(text, "disconnect", "README.md disconnect", errors);
  requireToken(text, "migration", "README.md migration", errors);
  requireToken(text, "dry-run", "README.md migration dry-run", errors);
  requireToken(
    text,
    "default model",
    "README.md default-model preservation",
    errors,
  );
  requireToken(
    text,
    "credential",
    "README.md credential-only disconnect",
    errors,
  );
}

function validateChineseReadme(text: string, errors: string[]): void {
  // The exact install command and pinned SHA must appear verbatim.
  requireToken(text, GIT_SPEC, "README.zh.md git-install spec", errors);
  requireToken(
    text,
    `dsh plugin --profile web add ${GIT_SPEC}`,
    "README.zh.md install command",
    errors,
  );
  requireToken(
    text,
    "dsh plugin --profile web remove dsh-opencode-go-provider",
    "README.zh.md uninstall command",
    errors,
  );
  requireToken(text, "未发布", "README.zh.md npm-unpublished status", errors);
  forbidClaim(text, NPM_INSTALL_CLAIM, "README.zh.md npm-install availability", errors);

  requireToken(text, "不隶属", "README.zh.md non-affiliation", errors);
  requireToken(text, "DeepSeek", "README.zh.md non-affiliation DeepSeek", errors);
  requireToken(text, "OpenCode", "README.zh.md non-affiliation OpenCode", errors);

  requireToken(text, CREDENTIAL_REF, "README.zh.md credential ref", errors);
  requireToken(text, "操作时", "README.zh.md credential resolution timing", errors);
  requireToken(text, ROUTE, "README.zh.md route", errors);

  for (const protocol of PROTOCOLS) {
    requireToken(text, protocol, "README.zh.md protocol", errors);
  }
  requireToken(text, "前缀", "README.zh.md no-prefix-guessing", errors);

  requireToken(text, "rc.6", "README.zh.md DSH rc.6 compatibility", errors);
  requireToken(text, "22.19", "README.zh.md Node engine floor", errors);
  requireToken(text, "11.7.0", "README.zh.md pnpm version", errors);

  requireToken(text, "models.dev", "README.zh.md models.dev metadata", errors);
  requireToken(text, "stale-while-revalidate", "README.zh.md SWR", errors);
  requireTiming(text, "5", "分钟", "README.zh.md freshness", errors);
  requireTiming(text, "60", "分钟", "README.zh.md refresh interval", errors);
  requireTiming(text, "10", "秒", "README.zh.md network timeout", errors);
  requireToken(text, "原子", "README.zh.md atomic cache", errors);
  requireToken(text, "离线", "README.zh.md offline fallback", errors);
  requireToken(text, "隔离", "README.zh.md quarantine", errors);
  requireToken(text, "14 天", "README.zh.md deprecated grace", errors);

  requireToken(text, "连接", "README.zh.md connect", errors);
  requireToken(text, "状态", "README.zh.md status", errors);
  requireToken(text, "诊断", "README.zh.md doctor", errors);
  requireToken(text, "断开", "README.zh.md disconnect", errors);
  requireToken(text, "迁移", "README.zh.md migration", errors);
  requireToken(text, "dry-run", "README.zh.md migration dry-run", errors);
  requireToken(text, "默认模型", "README.zh.md default-model preservation", errors);
  requireToken(text, "凭据", "README.zh.md credential boundary", errors);
}

function validateSecurity(text: string, errors: string[]): void {
  requireToken(text, CREDENTIAL_REF, "SECURITY.md credential ref", errors);
  requireToken(
    text,
    "credentials",
    "SECURITY.md credential handling",
    errors,
  );
  requireToken(
    text,
    "vulnerability reporting",
    "SECURITY.md reporting route",
    errors,
  );
  requireToken(
    text,
    "diagnostic",
    "SECURITY.md safe diagnostics",
    errors,
  );
  requireToken(
    text,
    "update",
    "SECURITY.md update policy",
    errors,
  );
  // No nonexistent private route may be claimed: the GitHub profile publishes
  // no public email and GitHub provides no direct-message route, so SECURITY
  // must not present either as a reporting fallback.
  if (/[Ee]mail/.test(text)) {
    errors.push("SECURITY.md must not mention an email route");
  }
  if (/direct message|direct-message/.test(text)) {
    errors.push("SECURITY.md must not claim a direct-message route");
  }
}

function validateContributing(text: string, errors: string[]): void {
  requireToken(text, "11.7.0", "CONTRIBUTING.md pnpm version", errors);
  requireToken(text, "corepack", "CONTRIBUTING.md corepack", errors);
  requireToken(text, "test", "CONTRIBUTING.md TDD/testing", errors);
  requireToken(text, "typecheck", "CONTRIBUTING.md typecheck gate", errors);
  requireToken(text, "pack:check", "CONTRIBUTING.md pack gate", errors);
  requireToken(text, "250", "CONTRIBUTING.md LOC ceiling", errors);
  requireToken(
    text,
    "network",
    "CONTRIBUTING.md no-live-network default",
    errors,
  );
}

function validateNotices(text: string, errors: string[]): void {
  // Existing upstream attribution must be retained (MIT, 2025) alongside the
  // independent-implementation note for pi-opencode-go-provider.
  requireToken(text, "MIT", "THIRD_PARTY_NOTICES.md MIT license", errors);
  requireToken(
    text,
    "2025",
    "THIRD_PARTY_NOTICES.md upstream copyright year",
    errors,
  );
  requireToken(
    text,
    "pi-opencode-go-provider",
    "THIRD_PARTY_NOTICES.md upstream project",
    errors,
  );
  requireToken(
    text,
    "independent implementation",
    "THIRD_PARTY_NOTICES.md derivation note",
    errors,
  );
  // The notices must point readers at each dependency's own distribution for
  // license texts, and must NOT claim this repository's LICENSE reproduces
  // peer license texts.
  requireToken(
    text,
    "dependency",
    "THIRD_PARTY_NOTICES.md per-dependency license pointer",
    errors,
  );
  if (/reproduced.*(?:this repository|LICENSE)|LICENSE.*(?:where applicable)/i.test(text)) {
    errors.push("THIRD_PARTY_NOTICES.md must not claim LICENSE reproduces peer licenses");
  }
}
