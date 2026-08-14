/**
 * Fixed, sanitized failure messages for the SWR refresh path.
 *
 * Every failure outcome/event carries a code plus this fixed message — never
 * raw injected error text, response bodies, URLs, key fragments, headers or
 * absolute paths. An injected seam that throws hostile text therefore cannot
 * smuggle secrets into outcomes, events, logs or evidence.
 */
export function failureMessage(code: string): string {
  switch (code) {
    case "MISSING_CREDENTIAL":
      return "the provider credential is not set";
    case "INVALID_CREDENTIAL":
      return "the provider credential is not canonical";
    case "MODELS_DEV_HTTP_401":
    case "MODELS_DEV_HTTP_403":
    case "MODELS_DEV_HTTP_503":
    case "MODELS_DEV_HTTP_5XX":
    case "MODELS_DEV_HTTP_ERROR":
      return "the models.dev source failed";
    case "LIVE_HTTP_401":
    case "LIVE_HTTP_403":
    case "LIVE_HTTP_503":
    case "LIVE_HTTP_5XX":
    case "LIVE_HTTP_ERROR":
      return "the live /models source failed";
    case "LIVE_HTTP_429":
      return "the live /models source is rate-limiting the provider credential";
    case "MODELS_DEV_PARSE":
      return "the models.dev payload could not be parsed";
    case "LIVE_PARSE":
      return "the live /models payload could not be parsed";
    case "NO_LIVE_BASE_URL":
      return "models.dev carries no usable live base URL";
    case "FETCH_FAILED":
      return "the refresh attempt could not complete its network work";
    case "TIMEOUT":
      return "the refresh attempt exceeded its deadline";
    case "ABORTED":
      return "the refresh attempt was aborted";
    case "INTERNAL":
      return "the refresh attempt failed internally";
    case "CACHE_WRITE_FAILED":
      return "the runtime cache could not be written";
    default:
      return "the refresh attempt failed";
  }
}
