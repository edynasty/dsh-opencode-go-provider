#!/usr/bin/env node
/**
 * live-smoke — opt-in live connectivity smoke for dsh-opencode-go-provider.
 *
 * Default execution is a NO-OP: it prints the fixed `skipped` line and exits 0
 * BEFORE reading any key or touching the network, so keyless CI and keyless
 * contributors stay green.
 *
 * The smoke runs ONLY when BOTH conditions hold:
 *   - `RUN_OPENCODE_GO_LIVE=1` (explicit local opt-in), and
 *   - a local `OPENCODE_GO_API_KEY` is set (read from the environment only,
 *     never from files, argv or DSH stores).
 *
 * Opt-in without a key fails with a fixed sanitized message and a non-zero
 * exit code; the key itself is never echoed. The live mode performs exactly
 * one authenticated GET against the non-billing availability endpoint
 * (https://opencode.ai/zen/go/v1/models) and prints a sanitized count.
 */
const LIVE_OPT_IN = "RUN_OPENCODE_GO_LIVE";
const KEY_ENV = "OPENCODE_GO_API_KEY";
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";

const SKIPPED_LINE = "live-smoke: skipped (RUN_OPENCODE_GO_LIVE is not set to 1)";
const NO_KEY_LINE = "live-smoke: refused — opt-in requires a local OPENCODE_GO_API_KEY";

if (process.env[LIVE_OPT_IN] !== "1") {
  process.stdout.write(`${SKIPPED_LINE}\n`);
  process.exit(0);
}

const key = process.env[KEY_ENV];
if (key === undefined || key === "") {
  process.stderr.write(`${NO_KEY_LINE}\n`);
  process.exit(1);
}

// Live mode: exactly one authenticated GET to the availability endpoint.
// Never invoked by CI or by the default `check`; local opt-in only.
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  const response = await fetch(MODELS_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
    signal: controller.signal,
  });
  if (!response.ok) {
    process.stderr.write(`live-smoke: failed (HTTP ${response.status})\n`);
    process.exit(1);
  }
  const payload = await response.json();
  const ids = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => (entry && typeof entry === "object" && "id" in entry ? entry.id : undefined))
        .filter((id) => typeof id === "string")
    : [];
  process.stdout.write(`live-smoke: ok — ${ids.length} available model ids\n`);
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error && error.name === "AbortError"
    ? "timeout"
    : "transport";
  process.stderr.write(`live-smoke: failed (${reason})\n`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
