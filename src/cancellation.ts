/**
 * Cancellation primitives for the SWR refresh path.
 *
 * The logical attempt deadline and owner cancellation must be authoritative
 * even when an injected seam (credential or fetch) ignores the AbortSignal:
 * `raceCancellation` settles on whichever comes first — the seam's promise or
 * the abort — so a never-resolving seam still yields TIMEOUT/ABORTED and a
 * late result after abort is discarded, never used. `throwIfCancelled` guards
 * synchronous boundaries (post-await, pre-reconcile). Listeners are removed
 * on settlement, so no leak survives a late resolution.
 */
import { timeoutOf } from "@deepseek-ai/dsh-timeout";

/** The two cancellation classes an attempt can report. */
export type CancellationCode = "TIMEOUT" | "ABORTED";

/** Classify an aborted signal: deadline first, then owner cancellation. */
export function cancellationCode(signal: AbortSignal, deadlineCode: string): CancellationCode | undefined {
  if (timeoutOf(signal, deadlineCode) !== undefined) return "TIMEOUT";
  if (signal.aborted) return "ABORTED";
  return undefined;
}

/** Distinguish a cancelled attempt from any other thrown value. */
export class AttemptCancelled extends Error {
  readonly code: CancellationCode;
  constructor(code: CancellationCode) {
    super(`attempt cancelled (${code})`);
    this.code = code;
  }
}

/** Throw AttemptCancelled when the signal is already aborted. */
export function throwIfCancelled(signal: AbortSignal, deadlineCode: string): void {
  const code = cancellationCode(signal, deadlineCode);
  if (code !== undefined) throw new AttemptCancelled(code);
}

/** The first of a seam promise or the abort to settle wins; the other is dropped. */
export type RaceResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "cancelled"; readonly code: CancellationCode };

/**
 * Race one async seam against the fused signal. The supplied promise is
 * observed FIRST — fulfillment/rejection handlers are attached before any
 * pre-abort result is returned — so a seam promise that resolves or rejects
 * late can never produce an unhandled rejection. On abort, the result is
 * cancelled; the late settlement is then a no-op finish.
 */
export function raceCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadlineCode: string,
): Promise<RaceResult<T>> {
  return new Promise<RaceResult<T>>((resolve) => {
    let finished = false;
    const finish = (result: RaceResult<T>): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      finish({ kind: "cancelled", code: cancellationCode(signal, deadlineCode) ?? "ABORTED" });
    };
    // Attach handlers before the pre-abort check: a late settlement of an
    // already-created promise must still be observed, never unhandled.
    void promise.then(
      (value) => finish({ kind: "value", value }),
      (error) => finish({ kind: "error", error }),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
