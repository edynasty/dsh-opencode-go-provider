/**
 * OpenCode Go base URL boundary.
 *
 * Every base URL this route ever sends a request (or a credential) to must be
 * HTTPS on exactly `opencode.ai` under the `/zen/go` endpoint family, with no
 * userinfo, query or hash. Anything else — http, lookalike hosts, localhost,
 * IPs, protocol-relative URLs, foreign paths — fails closed so a malicious
 * metadata record can never become a request target.
 */
import { isString } from "./guards.ts";

const ALLOWED_HOST = "opencode.ai" as const;

/**
 * Validate a base URL against the OpenCode Go endpoint boundary and return
 * its canonical href; `undefined` means the value is not acceptable.
 */
export function parseBaseUrl(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.hostname !== ALLOWED_HOST) return undefined;
  if (url.pathname !== "/zen/go" && !url.pathname.startsWith("/zen/go/")) return undefined;
  return url.href;
}

/**
 * Build the live `/models` endpoint from a validated base URL via the URL API
 * (never string concatenation). `undefined` means the base URL is invalid.
 */
export function buildLiveModelsEndpoint(value: unknown): string | undefined {
  const base = parseBaseUrl(value);
  if (base === undefined) return undefined;
  const url = new URL(base);
  url.pathname = url.pathname.endsWith("/") ? `${url.pathname}models` : `${url.pathname}/models`;
  return url.href;
}
