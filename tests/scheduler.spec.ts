/**
 * Task 7 scheduler ownership contract (red-first).
 *
 * `defaultScheduler` must delete a timer's ownership entry BEFORE invoking
 * its callback: every fire leaves zero owned entries, `clearTimer` removes
 * the entry, a throwing callback cannot retain its entry (deletion already
 * happened), and many fired timers leave the map empty. The count is exposed
 * through the narrow test-safe `ownedTimerCount` seam (internal to the
 * production wiring, not part of the package surface).
 */
import { describe, expect, it } from "vitest";
import { defaultScheduler } from "../src/scheduler.ts";
import type { TimerHandle } from "../src/sync.ts";

/** Bounded event-loop yield: let a 0ms real timer fire without a sleep. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("test: condition not reached after event-loop turns");
}

describe("defaultScheduler", () => {
  it("clears a pending timer's ownership entry", () => {
    const scheduler = defaultScheduler();
    scheduler.setTimer(() => undefined, 10_000);
    const handle: TimerHandle = { id: 1 };
    expect(scheduler.ownedTimerCount()).toBe(1);
    scheduler.clearTimer(handle);
    expect(scheduler.ownedTimerCount()).toBe(0);
  });

  it("deletes the ownership entry BEFORE the callback runs and leaves zero after fire", async () => {
    const scheduler = defaultScheduler();
    let seenInsideCallback: number | undefined;
    scheduler.setTimer(() => {
      seenInsideCallback = scheduler.ownedTimerCount();
    }, 0);
    await waitFor(() => seenInsideCallback !== undefined);
    expect(seenInsideCallback).toBe(0);
    expect(scheduler.ownedTimerCount()).toBe(0);
  });

  it("leaves zero owned entries after many timers fired", async () => {
    const scheduler = defaultScheduler();
    let fired = 0;
    for (let index = 0; index < 25; index += 1) {
      scheduler.setTimer(() => {
        fired += 1;
      }, 0);
    }
    await waitFor(() => fired === 25);
    expect(scheduler.ownedTimerCount()).toBe(0);
  });

  it("a throwing callback cannot retain its ownership entry", async () => {
    const scheduler = defaultScheduler();
    const uncaught = new Promise<unknown>((resolve) => {
      process.once("uncaughtException", (error) => resolve(error));
    });
    scheduler.setTimer(() => {
      throw new Error("scheduler callback boom");
    }, 0);
    await uncaught;
    expect(scheduler.ownedTimerCount()).toBe(0);
  });
});
