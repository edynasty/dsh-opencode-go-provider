/**
 * Task 5 remediation: provider-failure classifier regressions (red-first).
 *
 * An explicit HTTP 429 must win over quota wording: the provider status is the
 * authoritative signal, and the harness treats RATE_LIMIT and QUOTA
 * differently. Quota classification is retained for quota messages that carry
 * no 429 status.
 */
import { describe, expect, it } from "vitest";
import { QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { AUTH, RATE_LIMIT, SERVER, TRANSPORT, classifyProviderFailure } from "../src/errors.ts";

describe("classifyProviderFailure status precedence", () => {
  it("maps '429 quota exceeded' to RATE_LIMIT", () => {
    expect(classifyProviderFailure("429 quota exceeded")).toBe(RATE_LIMIT);
  });

  it("maps 'HTTP 429 insufficient_quota' to RATE_LIMIT", () => {
    expect(classifyProviderFailure("HTTP 429 insufficient_quota: monthly limit reached")).toBe(RATE_LIMIT);
  });

  it("keeps a quota-only message without 429 as QUOTA", () => {
    expect(classifyProviderFailure("insufficient_quota: your account quota is exhausted")).toBe(QUOTA_EXCEEDED_CODE);
  });

  it("keeps 'quota exceeded' without a status as QUOTA", () => {
    expect(classifyProviderFailure("quota exceeded")).toBe(QUOTA_EXCEEDED_CODE);
  });

  it("keeps the remaining stable classes", () => {
    expect(classifyProviderFailure("HTTP 401 invalid_api_key")).toBe(AUTH);
    expect(classifyProviderFailure("HTTP 500 internal server error")).toBe(SERVER);
    expect(classifyProviderFailure("Connection error.")).toBe(TRANSPORT);
  });
});
