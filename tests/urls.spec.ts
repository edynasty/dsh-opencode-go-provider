/**
 * OpenCode Go base URL boundary specs (Task 3 third remediation).
 *
 * Every models.dev/patch/state base URL used by this route must be HTTPS on
 * exactly opencode.ai under the /zen/go endpoint family, without credentials,
 * query or hash. Malicious or lookalike endpoints fail closed so a credential
 * can never be routed there.
 */
import { describe, expect, it } from "vitest";
import { buildLiveModelsEndpoint, parseBaseUrl } from "../src/urls.ts";

describe("parseBaseUrl", () => {
  it("accepts the real OpenCode Go endpoints", () => {
    // Given: the provider and anthropic base URLs in production use.
    // When: the URL boundary validates them.
    const provider = parseBaseUrl("https://opencode.ai/zen/go/v1");
    const anthropic = parseBaseUrl("https://opencode.ai/zen/go");
    // Then: both pass and round-trip canonically.
    expect(provider).toBe("https://opencode.ai/zen/go/v1");
    expect(anthropic).toBe("https://opencode.ai/zen/go");
  });

  it("rejects non-HTTPS, protocol-relative and credential-bearing URLs", () => {
    // Given: http, protocol-relative and userinfo URLs.
    // Then: every one is rejected.
    expect(parseBaseUrl("http://opencode.ai/zen/go")).toBeUndefined();
    expect(parseBaseUrl("//opencode.ai/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://user:pass@opencode.ai/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://user@opencode.ai/zen/go")).toBeUndefined();
  });

  it("rejects lookalike hosts, localhost, IPs and unrelated paths", () => {
    // Given: hosts that are not exactly opencode.ai and foreign paths.
    // Then: every one is rejected (no endsWith lookalike logic).
    expect(parseBaseUrl("https://opencode.ai.evil.com/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://evilopencode.ai/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://localhost/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://127.0.0.1/zen/go")).toBeUndefined();
    expect(parseBaseUrl("https://opencode.ai/other")).toBeUndefined();
    expect(parseBaseUrl("https://opencode.ai/")).toBeUndefined();
  });

  it("rejects query strings and hash fragments", () => {
    // Given: URLs carrying query or fragment.
    expect(parseBaseUrl("https://opencode.ai/zen/go?redirect=evil")).toBeUndefined();
    expect(parseBaseUrl("https://opencode.ai/zen/go#frag")).toBeUndefined();
  });

  it("rejects non-string values", () => {
    // Given: non-string api/baseUrl values.
    expect(parseBaseUrl(42)).toBeUndefined();
    expect(parseBaseUrl(undefined)).toBeUndefined();
  });
});

describe("buildLiveModelsEndpoint", () => {
  it("appends /models through the URL API without string concatenation", () => {
    // Given: a validated provider base URL.
    // When: the live models endpoint is built.
    const endpoint = buildLiveModelsEndpoint("https://opencode.ai/zen/go/v1");
    // Then: the path is constructed via the URL object.
    expect(endpoint).toBe("https://opencode.ai/zen/go/v1/models");
    expect(buildLiveModelsEndpoint("https://opencode.ai/zen/go")).toBe("https://opencode.ai/zen/go/models");
  });

  it("returns undefined for invalid base URLs", () => {
    // Given: a malicious or malformed base URL.
    // Then: no endpoint is produced and no credential can be routed.
    expect(buildLiveModelsEndpoint("http://evil.example.com/v1")).toBeUndefined();
    expect(buildLiveModelsEndpoint("https://opencode.ai/other")).toBeUndefined();
    expect(buildLiveModelsEndpoint("not a url")).toBeUndefined();
  });
});
