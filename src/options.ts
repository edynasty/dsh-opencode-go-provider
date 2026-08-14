/**
 * Exhaustive `GenerateOptions` field audit for the OpenCode Go adapter.
 *
 * Every field of the current public `GenerateOptions` type is either supported
 * (mapped with observable wire semantics elsewhere in the adapter) or rejected
 * here pre-network with a stable code; an unknown key is refused loudly rather
 * than silently ignored, so a future field addition cannot pass unnoticed.
 */
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { UNSUPPORTED_OPTION, llmError } from "./errors.ts";

/** Every field of the current public `GenerateOptions` type, audited. */
const SUPPORTED_OPTION_KEYS = [
  "provider",
  "model",
  "reasoningEffort",
  "messages",
  "system",
  "tools",
  "temperature",
  "maxTokens",
  "stop",
  "signal",
  "sessionId",
  "purpose",
] as const;

/** Reject any request option this adapter cannot express, before network. */
export function assertSupportedOptions(options: GenerateOptions): void {
  for (const key of Object.keys(options)) {
    if (!SUPPORTED_OPTION_KEYS.some((known) => known === key)) {
      throw llmError(`opencode-go does not support GenerateOptions.${key}`, UNSUPPORTED_OPTION);
    }
  }
  if (options.stop !== undefined) {
    throw llmError("opencode-go does not support GenerateOptions.stop", UNSUPPORTED_OPTION);
  }
  if (options.purpose !== undefined) {
    throw llmError(
      `opencode-go does not support GenerateOptions.purpose "${options.purpose}"`,
      UNSUPPORTED_OPTION,
    );
  }
}
