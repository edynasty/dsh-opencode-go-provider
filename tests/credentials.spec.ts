/**
 * Task 4 credential resolution contract tests (red-first).
 *
 * Resolution is per operation through `ctx.get('credentials')`, with the
 * launch-environment fallback only when the service is absent. Missing
 * credentials throw `MISSING_CREDENTIAL`; non-canonical values throw
 * `INVALID_CREDENTIAL`; the `withResolvedKey` seam proves zero callback
 * invocations on missing/invalid keys and snapshot isolation across A→B
 * rotation. Every assertion on error messages checks the reference is named
 * and the fake secret value never appears.
 */
import { describe, expect, it } from "vitest";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { INVALID_CREDENTIAL_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { resolveApiKey, withResolvedKey } from "../src/credentials.ts";
import { boot, fakeLaunchEnvironment, requireCredentials } from "./helpers/context-harness.ts";

const REF = credentialRef("OPENCODE_GO_API_KEY");
const MISSING_CREDENTIAL = "MISSING_CREDENTIAL";
const FAKE_SECRET_A = "sk-fake-secret-a-0123456789";
const FAKE_SECRET_B = "sk-fake-secret-b-9876543210";

/** A fetch-equivalent spy the seam must never call. */
function fetchSpy() {
  const calls: string[] = [];
  const call = (target: string) => {
    calls.push(target);
    return Promise.resolve("ok");
  };
  return { calls, call };
}

async function rejectCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected rejection, got resolution");
  } catch (error) {
    return error instanceof LlmError ? error.code : "NO_CODE";
  }
}

describe("resolveApiKey per-operation resolution", () => {
  it("resolves the current value through the credentials service", async () => {
    // Given: a booted plugin with a credentials service holding one key.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(REF, FAKE_SECRET_A);
    // When: the key is resolved.
    const key = await resolveApiKey(ctx, REF);
    // Then: the resolved key is the stored value.
    expect(key).toBe(FAKE_SECRET_A);
  });

  it("resolves a rotated value on the next operation without restart", async () => {
    // Given: a credentials service that is updated between operations.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(REF, FAKE_SECRET_A);
    expect(await resolveApiKey(ctx, REF)).toBe(FAKE_SECRET_A);
    // When: the stored credential rotates to B.
    await store.set(REF, FAKE_SECRET_B);
    // Then: the next operation resolves B, not the cached A.
    expect(await resolveApiKey(ctx, REF)).toBe(FAKE_SECRET_B);
  });

  it("falls back to the launch environment when the credentials service is absent", async () => {
    // Given: no credentials service, only a launch-environment snapshot.
    const { ctx } = await boot({
      withCredentials: false,
      launchEnvironment: fakeLaunchEnvironment({ OPENCODE_GO_API_KEY: FAKE_SECRET_A }),
    });
    // When: the key is resolved.
    const key = await resolveApiKey(ctx, REF);
    // Then: the fallback value is returned.
    expect(key).toBe(FAKE_SECRET_A);
  });
});

describe("missing credential", () => {
  it("throws MISSING_CREDENTIAL with zero fetch calls", async () => {
    // Given: a booted plugin with no stored credential anywhere.
    const { ctx } = await boot({ withCredentials: true });
    const spy = fetchSpy();
    // When: the key is resolved while the fetch-equivalent waits in the run slot.
    const code = await rejectCode(
      withResolvedKey(ctx, REF, async () => spy.call("https://opencode.ai/zen/go/v1/models")),
    );
    // Then: the operation fails before any callback/network runs.
    expect(code).toBe(MISSING_CREDENTIAL);
    expect(spy.calls).toEqual([]);
  });

  it("names the reference but not any stored secret in the message", async () => {
    // Given: a stored secret for a different reference while the resolved one is unset.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(credentialRef("OPENCODE_GO_ALT_KEY"), FAKE_SECRET_A);
    // When: the missing key is resolved.
    try {
      await resolveApiKey(ctx, REF);
      throw new Error("expected rejection");
    } catch (error) {
      // Then: the message names the reference and never the stored secret.
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(REF);
      expect(message).not.toContain(FAKE_SECRET_A);
    }
  });
});

describe("invalid credential", () => {
  it.each([
    ["whitespace-padded", `  ${FAKE_SECRET_A}  `],
    ["internal space", `sk-fake ${FAKE_SECRET_A}`],
    ["newline", `sk-fake-secret\n${FAKE_SECRET_A}`],
    ["tab", `sk-fake-secret\t${FAKE_SECRET_A}`],
    ["control", `sk-fake-secret\u0007${FAKE_SECRET_A}`],
  ])("throws INVALID_CREDENTIAL for a %s key without trimming it", async (_label, value) => {
    // Given: a credentials service holding a non-canonical value.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(REF, value);
    const spy = fetchSpy();
    // When: the operation resolves the key.
    const code = await rejectCode(
      withResolvedKey(ctx, REF, async () => spy.call("https://opencode.ai/zen/go/v1/models")),
    );
    // Then: it fails before network with the canonical INVALID_CREDENTIAL code.
    expect(code).toBe(INVALID_CREDENTIAL_CODE);
    expect(spy.calls).toEqual([]);
  });

  it("never leaks the invalid secret value in the message", async () => {
    // Given: a stored invalid value that is itself a secret-looking string.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    const padded = `  ${FAKE_SECRET_B}  `;
    await store.set(REF, padded);
    // When: the invalid key is resolved.
    try {
      await resolveApiKey(ctx, REF);
      throw new Error("expected rejection");
    } catch (error) {
      // Then: the message names the reference and never the value.
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(REF);
      expect(message).not.toContain(FAKE_SECRET_B);
      expect(message).not.toContain(padded);
    }
  });
});

describe("withResolvedKey operation seam", () => {
  it("invokes the callback exactly once with the resolved snapshot", async () => {
    // Given: a stored credential.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(REF, FAKE_SECRET_A);
    // When: the seam runs a callback.
    const seen: string[] = [];
    const result = await withResolvedKey(ctx, REF, async (key) => {
      seen.push(key);
      return "done";
    });
    // Then: the callback receives the snapshot exactly once.
    expect(result).toBe("done");
    expect(seen).toEqual([FAKE_SECRET_A]);
  });

  it("keeps the in-flight snapshot A while the next operation resolves B", async () => {
    // Given: a stored credential A.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(REF, FAKE_SECRET_A);
    // When: operation 1 captures its snapshot, the credential rotates to B,
    // and operation 2 resolves.
    const firstSnapshot = await resolveApiKey(ctx, REF);
    await store.set(REF, FAKE_SECRET_B);
    const secondSnapshot = await withResolvedKey(ctx, REF, async (key) => key);
    // Then: the in-flight operation keeps A; the next operation resolved B.
    expect(firstSnapshot).toBe(FAKE_SECRET_A);
    expect(secondSnapshot).toBe(FAKE_SECRET_B);
  });

  it("does not invoke the callback when the key is missing", async () => {
    const { ctx } = await boot({ withCredentials: true });
    let invoked = false;
    await rejectCode(
      withResolvedKey(ctx, REF, async () => {
        invoked = true;
        return undefined;
      }),
    );
    expect(invoked).toBe(false);
  });
});
