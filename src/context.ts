/**
 * Harness request conversion into pi-ai's `Context` vocabulary.
 *
 * Text-only history converts synchronously; image-bearing history reads bytes
 * through the durable attachment service. Assistant messages reconstruct
 * through the replay projection so reasoning and tool continuation survive.
 */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool } from "@earendil-works/pi-ai";
import { CallId, contentHasImage, LlmError } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, Message, ToolResultBlock } from "@deepseek-ai/dsh-llm";
import { INVALID_REQUEST, UNSUPPORTED_CONTENT } from "./errors.ts";
import { toPiAssistant } from "./replay.ts";

/** Join the text blocks of one harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Flatten text recursively inside one tool result's content. */
function toolResultText(blocks: readonly Message["content"][number][]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : ""))
    .join("");
}

/**
 * Resolve the tool name for one tool result. A result whose call id matches no
 * assistant tool call in the request is a broken conversation and fails before
 * network instead of fabricating a name.
 */
function toolNameOf(toolNames: ReadonlyMap<string, string>, result: ToolResultBlock): string {
  const toolName = toolNames.get(result.toolCallId);
  if (toolName === undefined) {
    throw new LlmError(
      `opencode-go tool result for call "${result.toolCallId}" has no matching assistant tool call`,
      INVALID_REQUEST,
    );
  }
  return toolName;
}

/** Convert user-role blocks into pi-ai content, resolving images via the store. */
async function userContent(
  blocks: readonly Message["content"][number][],
  attachments: AttachmentStore,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const stored = await attachments.readImage(block.attachment);
      content.push({
        type: "image",
        data: Buffer.from(stored.data).toString("base64"),
        mimeType: stored.ref.mediaType,
      });
      continue;
    }
    if (block.type === "tool-result") {
      const nested = await userContent(block.content, attachments);
      if (typeof nested === "string") {
        if (nested.length > 0) content.push({ type: "text", text: nested });
      } else {
        content.push(...nested);
      }
    }
  }
  if (content.every((piece) => piece.type === "text")) {
    return content.map((piece) => piece.text).join("");
  }
  return content;
}

/** Map harness tools into pi-ai tools (name/description/parameters). */
function toolsOf(options: GenerateOptions): Tool[] | undefined {
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return tools !== undefined && tools.length > 0 ? tools : undefined;
}

/** Assemble the request-level pi-ai context envelope. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options);
  return {
    ...(options.system === undefined ? {} : { systemPrompt: options.system }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

/**
 * Convert a text-only request into pi-ai context. System messages become user
 * role messages (pi-ai carries the system prompt separately), assistant
 * messages replay through the projection, and tool results become
 * `toolResult` messages correlated by call id.
 */
function textOnlyContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<string, string>();
  const messages: PiMessage[] = [];
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError(
        "opencode-go image input requires the durable attachment service",
        UNSUPPORTED_CONTENT,
      );
    }
    if (message.role === "system") {
      messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) {
        if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
      }
      messages.push(assistant);
      continue;
    }
    const text = flattenText(message);
    const results = message.content.filter((block): block is ToolResultBlock => block.type === "tool-result");
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: "user", content: text, timestamp: 0 });
    }
    for (const result of results) {
      messages.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: toolNameOf(toolNames, result),
        content: [{ type: "text", text: toolResultText(result.content) || "(no output)" }],
        isError: result.isError ?? false,
        timestamp: 0,
      });
    }
  }
  return piContext(options, messages);
}

/**
 * Convert a request (with optional images) into pi-ai context. Without an
 * attachment store the image-bearing path refuses before any read.
 * @param options - the fully assembled request.
 * @param attachments - the durable attachment service, when mounted.
 * @returns the pi-ai context envelope.
 */
export async function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
): Promise<PiContext> {
  if (attachments === undefined) return textOnlyContext(options);
  const toolNames = new Map<string, string>();
  const messages: PiMessage[] = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      if (contentHasImage(message.content)) {
        throw new LlmError(
          "opencode-go cannot represent an image in an in-history system message",
          UNSUPPORTED_CONTENT,
        );
      }
      messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) {
        if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
      }
      messages.push(assistant);
      continue;
    }
    const content = await userContent(
      message.content.filter((block) => block.type !== "tool-result"),
      attachments,
    );
    const results = message.content.filter((block): block is ToolResultBlock => block.type === "tool-result");
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: "user", content, timestamp: 0 });
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments);
      messages.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: toolNameOf(toolNames, result),
        content:
          typeof resultContent === "string"
            ? [{ type: "text", text: resultContent || "(no output)" }]
            : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      });
    }
  }
  return piContext(options, messages);
}
