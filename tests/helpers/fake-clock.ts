/**
 * Deterministic fake clock and scheduler for the Task 6 SWR lifecycle specs.
 *
 * The lifecycle and sync attempt read time exclusively through the injected
 * `Clock` and schedule exclusively through the injected `Scheduler`, so a
 * single `FakeClock` + `FakeScheduler` pair lets a test advance through
 * fresh → stale → refresh → 14-day-grace states without any wall-clock or
 * real-timer dependence. `advance` moves the shared clock first, then fires
 * every timer whose deadline has been reached (deadline order, insertion order
 * for ties). Re-armed timers created while firing are not part of the current
 * batch, so a periodic re-arm cannot loop inside one advance.
 */
import type { Clock, Scheduler, TimerHandle } from "../../src/sync.ts";

/** Mutable fake clock; `now()` returns the current fake instant. */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  /** The current fake instant in milliseconds (read-only accessor). */
  get value(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

interface PendingTimer {
  readonly at: number;
  readonly callback: () => void;
}

/**
 * Fake scheduler driven by the same `FakeClock` the lifecycle reads. Timers
 * fire only when `advance` crosses their deadline; `clearTimer` removes a
 * pending timer; `pendingCount` exposes open handles for disposal assertions.
 */
export class FakeScheduler implements Scheduler {
  private readonly timers = new Map<number, PendingTimer>();
  private nextId = 1;
  private fired = 0;

  constructor(private readonly clock: FakeClock) {}

  setTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.clock.value + delayMs, callback });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers.delete(handle.id);
  }

  /** Advance the clock and fire every timer whose deadline has been reached. */
  advance(ms: number): void {
    this.clock.advance(ms);
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.clock.value)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
      this.fired += 1;
    }
  }

  /** Number of armed, unfired timers (zero after a clean dispose). */
  pendingCount(): number {
    return this.timers.size;
  }

  /** Number of timers that fired (single-flight and scheduling evidence). */
  firedCount(): number {
    return this.fired;
  }
}
