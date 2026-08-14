/**
 * Per-operation credential resolution for the OpenCode Go provider.
 *
 * Resolution happens inside each operation through `ctx.get('credentials')`;
 * the launch environment is consulted only when no credentials service is
 * mounted. Nothing is cached across operations, so a rotated credential
 * reaches the next operation while an in-flight snapshot keeps the key it
 * started with. Missing credentials throw `MISSING_CREDENTIAL`; a supplied
 * value that is not a canonical key (whitespace, control characters) throws
 * `INVALID_CREDENTIAL` before any callback or network runs. Messages name the
 * reference and the route, never the value.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { INVALID_CREDENTIAL_CODE, LlmError, assertUsableApiKey } from "@deepseek-ai/dsh-llm";
import { BUNDLE_ROW_ID, PROVIDER_ROUTE } from "./contract.ts";
import { isCanonicalApiKey } from "./guards.ts";

/** Stable machine code for an absent credential (string literal, per DSH convention). */
export const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";

function missingMessage(ref: CredentialRef): string {
  return `${BUNDLE_ROW_ID}: no credential for provider route "${PROVIDER_ROUTE}"; its profile resolves`
    + ` ${ref}, which is not set — store ${ref} through the credentials service (the web Models page`
    + " writes it) or export it in the launching environment";
}

function nonCanonicalMessage(ref: CredentialRef): string {
  return `${BUNDLE_ROW_ID}: the API key resolved from ${ref} is not canonical (it carries whitespace`
    + ` or control characters); set ${ref} to the raw key alone — it is never trimmed or rewritten`;
}

/**
 * Resolve the active credential for one reference, per operation. The
 * credentials service is read fresh on every call; an absent service falls
 * back to the launching environment. Empty stored values are absent.
 * @param ctx - the consuming plugin's context.
 * @param ref - the reference to resolve.
 * @returns the canonical, header-carryable key.
 * @throws LlmError with code `MISSING_CREDENTIAL` when unset, or
 *   `INVALID_CREDENTIAL` when the value is non-canonical or unheaderable.
 */
export async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get("credentials");
  const hit = credentials !== undefined
    ? (await credentials.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value;
  if (hit !== undefined && hit.length > 0) {
    // Repository policy first: a non-canonical key is rejected, never silently
    // trimmed. The public helper then enforces header-carryability (printable
    // ASCII) and returns the usable value; a canonical input is already trimmed.
    if (!isCanonicalApiKey(hit)) {
      throw new LlmError(nonCanonicalMessage(ref), INVALID_CREDENTIAL_CODE);
    }
    return assertUsableApiKey(hit, BUNDLE_ROW_ID, ref);
  }
  throw new LlmError(missingMessage(ref), MISSING_CREDENTIAL_CODE);
}

/**
 * Resolve the key, then invoke the operation with the snapshot. The key is
 * captured before the callback starts, so an in-flight operation keeps the key
 * it began with even if the credential rotates; a missing or invalid key
 * throws before the callback (and therefore before any network) runs.
 * @param ctx - the consuming plugin's context.
 * @param ref - the reference to resolve.
 * @param run - the operation body, handed the resolved key snapshot.
 * @returns the operation's result.
 */
export async function withResolvedKey<T>(
  ctx: Context,
  ref: CredentialRef,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const key = await resolveApiKey(ctx, ref);
  return run(key);
}
