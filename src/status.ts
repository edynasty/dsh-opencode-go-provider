/**
 * Sanitized status facts for the OpenCode Go provider.
 *
 * Status never makes a network call: it reports credential configuration plus
 * lifecycle origin/current count/last refresh/last attempt facts, all read
 * from live runtime state and detached into an immutable snapshot. No secret
 * and no URL ever appears in the result.
 */
import type { SnapshotOrigin } from "./snapshot.ts";

/** The last sanitized refresh attempt fact the lifecycle observed. */
export type StatusLastAttempt =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "none" };

/** Lifecycle-derived facts (origin/count/freshness/attempts), secret-free. */
export interface LifecycleFacts {
  readonly origin: SnapshotOrigin;
  readonly modelCount: number;
  readonly refreshedAt: string;
  readonly lastAttempt: StatusLastAttempt;
  readonly attemptsSucceeded: number;
  readonly attemptsFailed: number;
}

/** The complete sanitized status result the control seam returns. */
export interface StatusResult extends LifecycleFacts {
  readonly configured: boolean;
  readonly configuredSource?: string;
}

/**
 * Detach and freeze a status snapshot from the credential description and the
 * lifecycle facts. `configuredSource` is omitted while absent so the object
 * stays exact under strict optional-property typing.
 */
export function buildStatus(
  configured: boolean,
  configuredSource: string | undefined,
  facts: LifecycleFacts,
): StatusResult {
  return Object.freeze({
    configured,
    ...(configuredSource === undefined ? {} : { configuredSource }),
    origin: facts.origin,
    modelCount: facts.modelCount,
    refreshedAt: facts.refreshedAt,
    lastAttempt: facts.lastAttempt,
    attemptsSucceeded: facts.attemptsSucceeded,
    attemptsFailed: facts.attemptsFailed,
  });
}
