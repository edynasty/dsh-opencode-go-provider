/**
 * Builder helpers for the three mock SSE dialects (Task 5 wire specs).
 *
 * Each builder returns the raw SSE bytes a loopback mock writes. The shapes
 * mirror the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages
 * streaming protocols as the pi-ai 0.82.1 API implementations parse them.
 */
import { sseAnthropic, sseData } from "./mock-server.ts";

export interface CompletionsDelta {
  readonly content?: string;
  readonly reasoningContent?: string;
  readonly toolCalls?: readonly {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
  }[];
}

/** One Chat Completions SSE chunk frame. */
export function completionsChunk(
  delta: CompletionsDelta,
  extra: { readonly finishReason?: string | null; readonly usage?: unknown } = {},
): string {
  const toolCalls = delta.toolCalls?.map((call) => ({
    index: call.index,
    ...(call.id === undefined ? {} : { id: call.id }),
    ...(call.name === undefined ? {} : { function: { name: call.name } }),
    ...(call.arguments === undefined ? {} : { function: { arguments: call.arguments } }),
  }));
  const payload: Record<string, unknown> = {
    id: "chatcmpl-task5",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          ...(delta.content === undefined ? {} : { content: delta.content }),
          ...(delta.reasoningContent === undefined ? {} : { reasoning_content: delta.reasoningContent }),
          ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: extra.finishReason ?? null,
      },
    ],
  };
  return sseData(payload);
}

/** Full happy-path Chat Completions stream: text then reasoning, stop, usage. */
export function completionsTextStream(usage: unknown): string {
  return [
    completionsChunk({ content: "Hello " }),
    completionsChunk({ content: "world" }),
    completionsChunk({ reasoningContent: "deep " }),
    completionsChunk({ reasoningContent: "thought" }),
    completionsChunk({}, { finishReason: "stop" }),
    sseData({
      id: "chatcmpl-task5",
      object: "chat.completion.chunk",
      model: "mock",
      choices: [],
      usage,
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/** Full tool-call Chat Completions stream ending with reason `tool_calls`. */
export function completionsToolStream(usage: unknown): string {
  return [
    completionsChunk({ toolCalls: [{ index: 0, id: "call_1", name: "get_weather" }] }),
    completionsChunk({ toolCalls: [{ index: 0, arguments: '{"city":"' }] }),
    completionsChunk({ toolCalls: [{ index: 0, arguments: "Beijing" }] }),
    completionsChunk({ toolCalls: [{ index: 0, arguments: '"}' }] }),
    completionsChunk({}, { finishReason: "tool_calls" }),
    sseData({ id: "chatcmpl-task5", object: "chat.completion.chunk", model: "mock", choices: [], usage }),
    "data: [DONE]\n\n",
  ].join("");
}

/** One OpenAI Responses event frame. */
export function responsesEvent(type: string, payload: Record<string, unknown>): string {
  return sseData({ type, ...payload });
}

/** Happy-path OpenAI Responses stream: text then reasoning, completed, usage. */
export function responsesTextStream(usage: unknown): string {
  return [
    responsesEvent("response.created", { response: { id: "resp_1", status: "in_progress", model: "mock", output: [] } }),
    responsesEvent("response.output_item.added", {
      output_index: 0,
      item: { id: "rsn_1", type: "reasoning", status: "in_progress", summary: [] },
    }),
    responsesEvent("response.reasoning_text.delta", { item_id: "rsn_1", output_index: 0, delta: "deep " }),
    responsesEvent("response.reasoning_text.delta", { item_id: "rsn_1", output_index: 0, delta: "thought" }),
    responsesEvent("response.output_item.done", {
      output_index: 0,
      item: { id: "rsn_1", type: "reasoning", status: "completed", summary: [], content: [{ type: "reasoning_text", text: "deep thought" }] },
    }),
    responsesEvent("response.output_item.added", {
      output_index: 1,
      item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
    }),
    responsesEvent("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hello" }),
    responsesEvent("response.output_item.done", {
      output_index: 1,
      item: { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
    }),
    responsesEvent("response.completed", {
      response: { id: "resp_1", status: "completed", model: "mock", output: [], usage },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/** Tool-call OpenAI Responses stream ending with a completed function call. */
export function responsesToolStream(usage: unknown): string {
  return [
    responsesEvent("response.created", { response: { id: "resp_1", status: "in_progress", model: "mock", output: [] } }),
    responsesEvent("response.output_item.added", {
      output_index: 0,
      item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_1", name: "get_weather", arguments: "" },
    }),
    responsesEvent("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: '{"city":"' }),
    responsesEvent("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: "Beijing" }),
    responsesEvent("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: '"}' }),
    responsesEvent("response.output_item.done", {
      output_index: 0,
      item: { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "get_weather", arguments: '{"city":"Beijing"}' },
    }),
    responsesEvent("response.completed", {
      response: { id: "resp_1", status: "completed", model: "mock", output: [], usage },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/** Happy-path Anthropic stream: text then thinking, end_turn, usage. */
export function anthropicTextStream(usage: unknown): string {
  return [
    sseAnthropic("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage },
    }),
    sseAnthropic("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    sseAnthropic("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseAnthropic("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "deep thought" } }),
    sseAnthropic("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseAnthropic("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    sseAnthropic("message_stop", { type: "message_stop" }),
  ].join("");
}

/** Tool-use Anthropic stream ending with stop reason `tool_use`. */
export function anthropicToolStream(usage: unknown): string {
  return [
    sseAnthropic("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage },
    }),
    sseAnthropic("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"' } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "Beijing" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } }),
    sseAnthropic("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseAnthropic("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } }),
    sseAnthropic("message_stop", { type: "message_stop" }),
  ].join("");
}

/** Shared usage payload per protocol dialect. */
export const USAGE = {
  completions: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  responses: {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
  anthropic: { input_tokens: 10, output_tokens: 9 },
} as const;

/** Anthropic stream: thinking block with signature delta, then a text block. */
export function anthropicThinkingStream(usage: unknown): string {
  return [
    sseAnthropic("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage },
    }),
    sseAnthropic("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deep thought" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc-123" } }),
    sseAnthropic("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseAnthropic("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    sseAnthropic("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
    sseAnthropic("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseAnthropic("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    sseAnthropic("message_stop", { type: "message_stop" }),
  ].join("");
}
