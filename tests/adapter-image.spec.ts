/**
 * Task 5 image-input contract (red-first).
 *
 * Image content is admitted only for a model whose catalog capabilities
 * include the image modality, and only when the durable attachment service is
 * available; both refusals happen before any network with a stable
 * `UNSUPPORTED_CONTENT` code. An admitted image reaches the wire as base64
 * with its verified media type.
 */
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentId, AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { ImageAttachmentRef, ImageAttachmentLimits, SaveImageAttachment, StoredImageAttachment } from "@deepseek-ai/dsh-attachment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Protocol } from "../src/types.ts";
import { expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { anthropicTextStream, completionsTextStream, responsesTextStream, USAGE } from "./helpers/sse-payloads.ts";
import { WIRE_NDJSON_PATH, collect, catalogModelFor, finishKind, makeAdapter, optionsFor, terminalCode } from "./helpers/adapter-fixtures.ts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const PNG_MEDIA = "image/png" as const;

/** Minimal attachment-store double that returns fixed bytes for any image ref. */
class FakeAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1_000_000,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 4_000_000,
    maxImagePixels: 4_000_000,
    mediaTypes: [PNG_MEDIA],
  };

  async validateImage(_input: SaveImageAttachment): Promise<void> {}

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return {
      attachmentId: AttachmentId("att_fake"),
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
    };
  }

  async readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return { ref, data: PNG_BYTES };
  }
}

/** One durable user message carrying an image block. */
function imageMessage(text: string) {
  return createUserMessage({
    content: [
      { type: "text", text },
      {
        type: "image",
        attachment: {
          attachmentId: AttachmentId("att_1"),
          mediaType: PNG_MEDIA,
          bytes: PNG_BYTES.length,
          width: 1,
          height: 1,
        },
      },
    ],
    source: { kind: "user" },
  });
}

/** A mock that records the request body and serves one happy stream. */
function bodyMock(protocol: Protocol, body: string) {
  const bodies: string[] = [];
  const start = async (): Promise<{ readonly bodies: readonly string[]; readonly baseUrl: string; readonly close: () => Promise<void> }> => {
    const mock = await startMock(WIRE_NDJSON_PATH, async (request, response, context) => {
      context.setProtocol(protocol);
      bodies.push(await context.body());
      if (request.url === expectedPath(protocol)) {
        sseHeaders(response);
        response.write(body);
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end("wrong path");
    });
    return { bodies, baseUrl: mock.baseUrl, close: mock.close };
  };
  return { start };
}

const HAPPY: Readonly<Record<Protocol, string>> = {
  "openai-completions": completionsTextStream(USAGE.completions),
  "openai-responses": responsesTextStream(USAGE.responses),
  "anthropic-messages": anthropicTextStream(USAGE.anthropic),
};

const IMAGE_CASES: readonly [Protocol, string][] = [
  ["openai-completions", "kimi-k2.5"],
  ["openai-responses", "grok-4.5"],
  ["anthropic-messages", "minimax-m3"],
];

describe("image admission", () => {
  it("rejects an image on a text-only model with UNSUPPORTED_CONTENT before network", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(
        () => [catalogModelFor("openai-completions", mock.baseUrl, "deepseek-v4-flash")],
        { resolveAttachments: () => new FakeAttachments(new Context()) },
      );
      const collected = await collect(
        adapter.stream({ ...optionsFor("deepseek-v4-flash", { messages: [imageMessage("describe")] }) }),
      );
      expect(terminalCode(collected)).toBe("UNSUPPORTED_CONTENT");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("rejects an image when no attachment service is mounted", async () => {
    const mock = await startMock(WIRE_NDJSON_PATH, () => undefined);
    try {
      const adapter = makeAdapter(() => [catalogModelFor("anthropic-messages", mock.baseUrl, "minimax-m3")]);
      const collected = await collect(
        adapter.stream({ ...optionsFor("minimax-m3", { messages: [imageMessage("describe")] }) }),
      );
      expect(terminalCode(collected)).toBe("UNSUPPORTED_CONTENT");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("admitted image content reaches the wire as base64 with its media type", async () => {
    for (const [protocol, model] of IMAGE_CASES) {
      const mock = await bodyMock(protocol, HAPPY[protocol]).start();
      try {
        const adapter = makeAdapter(() => [catalogModelFor(protocol, mock.baseUrl, model)], {
          resolveAttachments: () => new FakeAttachments(new Context()),
        });
        const collected = await collect(
          adapter.stream({ ...optionsFor(model, { messages: [imageMessage("describe")] }) }),
        );
        expect(finishKind(collected)).toBe("stop");
        expect(terminalCode(collected)).toBeUndefined();
        expect(mock.bodies).toHaveLength(1);
        const body = mock.bodies[0] ?? "";
        const base64 = Buffer.from(PNG_BYTES).toString("base64");
        expect(body).toContain(base64);
        expect(body).toContain(PNG_MEDIA);
      } finally {
        await mock.close();
      }
    }
  });
});
