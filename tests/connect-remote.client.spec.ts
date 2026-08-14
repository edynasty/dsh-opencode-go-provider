/**
 * Task 7 browser response-boundary contract (red-first, jsdom).
 *
 * The client boundary claims hostile/malformed Host bodies are sanitized:
 * arbitrary `message` strings never reach connect/disconnect results (fixed
 * local messages only), doctor/status failure codes pass an explicit safe
 * allowlist (unknown → `MALFORMED`/`UNKNOWN`, never rendered raw), and
 * numeric/string fields are strictly validated (finite nonnegative integers,
 * canonical ISO instants). Malicious payloads carrying fake key/path/Bearer
 * strings in message, code, count and timestamp never reach returned objects
 * or the DOM.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import {
  createConnectRemote,
  parseConnectResult,
  parseDisconnectResult,
  parseDoctorSummary,
  parseStatus,
} from "../src/client/connect-remote.ts";

const FAKE_KEY = "sk-client-boundary-fake-key-0123456789abcdef";
const MALICIOUS_MESSAGE = `drop path=/Users/evil Bearer ${FAKE_KEY} token=sk-abcdef0123456789`;
const MALICIOUS_CODE = `${FAKE_KEY} Bearer ${FAKE_KEY}`;
const MALICIOUS_COUNT = Number.POSITIVE_INFINITY;
const MALICIOUS_TIMESTAMP = `${FAKE_KEY} 2026-01-01`;

afterEach(() => {
  cleanup();
});

describe("connect/disconnect response boundary", () => {
  it("never copies an arbitrary Host message into a connect result", () => {
    const result = parseConnectResult({ kind: "invalid", message: MALICIOUS_MESSAGE });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message).not.toContain(FAKE_KEY);
      expect(result.message).not.toContain("/Users/evil");
      expect(result.message).not.toContain("Bearer");
    }
    expect(JSON.stringify(result)).not.toContain(MALICIOUS_MESSAGE);
  });

  it("never copies an arbitrary Host message into a disconnect result", () => {
    const result = parseDisconnectResult({ kind: "store-failed", message: MALICIOUS_MESSAGE });
    expect(result.kind).toBe("store-failed");
    if (result.kind === "store-failed") {
      expect(result.message).not.toContain(FAKE_KEY);
    }
    expect(JSON.stringify(result)).not.toContain(MALICIOUS_MESSAGE);
  });

  it("always returns fixed local messages regardless of the Host payload", () => {
    const connect = parseConnectResult({ kind: "invalid", message: "anything at all" });
    const disconnect = parseDisconnectResult({ kind: "store-failed", message: "anything at all" });
    expect(connect.kind === "invalid" ? connect.message : "").toBe("the key was refused before storing");
    expect(disconnect.kind === "store-failed" ? disconnect.message : "").toBe("the connection request failed");
  });
});

describe("doctor response boundary", () => {
  it("rejects a malicious failure code through the safe allowlist", () => {
    const result = parseDoctorSummary({ kind: "failed", code: MALICIOUS_CODE });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("MALFORMED");
      expect(result.code).not.toContain(FAKE_KEY);
    }
  });

  it("accepts only explicit known doctor codes", () => {
    const accepted = parseDoctorSummary({ kind: "failed", code: "LIVE_HTTP_401" });
    expect(accepted.kind === "failed" && accepted.code).toBe("LIVE_HTTP_401");
    const unknown = parseDoctorSummary({ kind: "failed", code: "SOME_NEW_CODE" });
    expect(unknown.kind === "failed" && unknown.code).toBe("MALFORMED");
  });

  it("requires liveModelCount to be a finite nonnegative integer", () => {
    const negative = parseDoctorSummary({ kind: "configured", liveModelCount: -3 });
    expect(negative.kind === "failed" && negative.code).toBe("MALFORMED");
    const fractional = parseDoctorSummary({ kind: "configured", liveModelCount: 1.5 });
    expect(fractional.kind === "failed" && fractional.code).toBe("MALFORMED");
    const malicious = parseDoctorSummary({ kind: "configured", liveModelCount: MALICIOUS_COUNT });
    expect(malicious.kind === "failed" && malicious.code).toBe("MALFORMED");
    const good = parseDoctorSummary({ kind: "configured", liveModelCount: 24 });
    expect(good.kind === "configured" && good.liveModelCount).toBe(24);
  });
});

describe("status response boundary", () => {
  function maliciousStatus(): unknown {
    return {
      configured: true,
      origin: "embedded",
      modelCount: MALICIOUS_COUNT,
      refreshedAt: MALICIOUS_TIMESTAMP,
      lastAttempt: { kind: "failed", code: MALICIOUS_CODE },
    };
  }

  it("rejects a malicious status payload as malformed", () => {
    expect(() => parseStatus(maliciousStatus())).toThrow();
  });

  it("rejects a non-canonical refreshedAt timestamp loudly", () => {
    // The malformed timestamp must never be propagated; parsing fails loudly.
    expect(() => parseStatus({
      configured: true,
      origin: "embedded",
      modelCount: 24,
      refreshedAt: "2026-01-01 not-an-iso",
      lastAttempt: { kind: "ok" },
    })).toThrow();
  });

  it("rejects a malicious lastAttempt failure code through the safe allowlist", () => {
    const result = parseStatus({
      configured: true,
      origin: "embedded",
      modelCount: 24,
      refreshedAt: "2026-08-14T00:00:00.000Z",
      lastAttempt: { kind: "failed", code: MALICIOUS_CODE },
    });
    expect(result.lastAttempt.kind).toBe("failed");
    if (result.lastAttempt.kind === "failed") {
      expect(result.lastAttempt.code).toBe("UNKNOWN");
      expect(result.lastAttempt.code).not.toContain(FAKE_KEY);
    }
  });

  it("accepts only explicit known attempt codes and finite nonnegative model counts", () => {
    const known = parseStatus({
      configured: true,
      origin: "embedded",
      modelCount: 24,
      refreshedAt: "2026-08-14T00:00:00.000Z",
      lastAttempt: { kind: "failed", code: "TIMEOUT" },
    });
    expect(known.lastAttempt.kind === "failed" && known.lastAttempt.code).toBe("TIMEOUT");
    const newCode = parseStatus({
      configured: true,
      origin: "embedded",
      modelCount: 24,
      refreshedAt: "2026-08-14T00:00:00.000Z",
      lastAttempt: { kind: "failed", code: "SOME_FUTURE_CODE" },
    });
    expect(newCode.lastAttempt.kind === "failed" && newCode.lastAttempt.code).toBe("UNKNOWN");
    expect(() => parseStatus({
      configured: true,
      origin: "embedded",
      modelCount: -1,
      refreshedAt: "2026-08-14T00:00:00.000Z",
      lastAttempt: { kind: "ok" },
    })).toThrow();
  });
});

describe("remote integration with a hostile Host payload", () => {
  it("never leaks Host text into the remote results or the DOM", async () => {
    const originalFetch = globalThis.fetch;
    const hostile = JSON.stringify({
      kind: "failed",
      code: MALICIOUS_CODE,
      message: MALICIOUS_MESSAGE,
      liveModelCount: MALICIOUS_COUNT,
    });
    globalThis.fetch = async () =>
      new Response(hostile, { status: 200, headers: { "content-type": "application/json" } });
    try {
      const remote = createConnectRemote();
      const doctor = await remote.doctor();
      const status = await remote.status().catch(() => ({ kind: "rejected" }));
      expect(JSON.stringify(doctor)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(doctor)).not.toContain("/Users/evil");
      expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
      expect(document.body.textContent).not.toContain(FAKE_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
