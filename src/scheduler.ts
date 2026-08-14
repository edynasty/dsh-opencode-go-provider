/**
 * Production scheduler: real timers, unref'd so they never hold the host open.
 * Shared by the SWR lifecycle and the doctor's bounded deadline.
 *
 * Every timer's ownership entry is deleted BEFORE its callback runs, so a
 * fired timer never leaks a map entry — including when the callback throws.
 * `ownedTimerCount` is the narrow test-safe count seam used by the scheduler
 * spec; it is internal to the production wiring, not part of the package
 * surface.
 */
import type { Scheduler } from "./sync.ts";

/** The production scheduler face: the `Scheduler` contract plus the count seam. */
export interface ProductionScheduler extends Scheduler {
  /** Number of timers still owned (fired/cleared timers are removed). */
  readonly ownedTimerCount: () => number;
}

/** Build the production timer scheduler (unref'd so disposal can end it). */
export function defaultScheduler(): ProductionScheduler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        // Ownership is released BEFORE the callback: a fired timer (even a
        // throwing one) can never retain its map entry.
        timers.delete(id);
        callback();
      }, delayMs);
      timer.unref?.();
      timers.set(id, timer);
      return { id };
    },
    clearTimer: (handle) => {
      const timer = timers.get(handle.id);
      if (timer !== undefined) {
        timers.delete(handle.id);
        clearTimeout(timer);
      }
    },
    ownedTimerCount: () => timers.size,
  };
}

/** Minimal clock helper: the current instant as a fresh Date. */
export function defaultClock(): { now(): Date } {
  return { now: () => new Date() };
}
