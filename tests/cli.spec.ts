/**
 * Generator CLI argument validation specs (Task 3 second remediation).
 *
 * Conflicting modes fail before any fetch or write instead of silently
 * prioritizing one source.
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/update-models.ts";

describe("CLI mode conflicts", () => {
  it("rejects --network combined with --live in either order", () => {
    // Given: both flags supplied in either order.
    // When: arguments are parsed.
    // Then: parsing fails before any network or filesystem activity.
    expect(() => parseArgs(["--network", "--live", "live.json"])).toThrow(/--live/);
    expect(() => parseArgs(["--live", "live.json", "--network"])).toThrow(/--live/);
  });

  it("accepts each mode on its own", () => {
    // Given: --network alone and --live alone.
    // When: arguments are parsed.
    // Then: both parse without error and carry their mode.
    const network = parseArgs(["--network"]);
    const live = parseArgs(["--live", "live.json"]);
    expect(network.network).toBe(true);
    expect(network.liveFile).toBeUndefined();
    expect(live.network).toBe(false);
    expect(live.liveFile).toBe("live.json");
  });
});
