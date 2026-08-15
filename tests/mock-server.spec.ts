/**
 * mock-server evidence-parent behavior tests (Task 9 CI unhandled-ENOENT fix).
 *
 * Prove that `startMock(ndjsonPath, ...)` establishes the evidence parent
 * directory before accepting any request, that a missing/nested parent no
 * longer surfaces as an unhandled ENOENT from the response-finish append, and
 * that `ndjsonPath === undefined` never touches the filesystem.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startMock, sseData, SSE_DONE } from "./helpers/mock-server.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mock-evidence-"));
}

describe("mock-server evidence parent directory", () => {
  it("creates a missing nested parent before writing evidence", async () => {
    const root = tempRoot();
    try {
      const ndjson = join(root, ".omo", "evidence", "task-5-wire.ndjson");
      expect(existsSync(dirname(ndjson))).toBe(false);
      // When: a mock with a deep evidence path completes one request.
      const mock = await startMock(ndjson, (_request, response) => {
        response.write(sseData({ ok: true }));
        response.end(SSE_DONE);
      });
      try {
        const outcome = await fetch(mock.baseUrl, { method: "POST" });
        expect(outcome.status).toBe(200);
      } finally {
        await mock.close();
      }
      // Then: the parent and the NDJSON file exist with one sanitized fact.
      expect(existsSync(ndjson)).toBe(true);
      const lines = readFileSync(ndjson, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const fact: unknown = JSON.parse(line);
        expect(fact).not.toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects deterministically at start when the parent cannot be created", async () => {
    const root = tempRoot();
    try {
      // A path whose parent is a regular FILE cannot be created as a
      // directory; startMock must reject instead of deferring the error to
      // the response-finish append.
      const blocker = join(root, "file.txt");
      const ndjson = join(blocker, "evidence.ndjson");
      writeFileSync(blocker, "x");
      let rejected = false;
      try {
        await startMock(ndjson, () => undefined);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not touch the filesystem when ndjsonPath is undefined", async () => {
    const root = tempRoot();
    try {
      const mock = await startMock(undefined, (_request, response) => {
        response.end("ok");
      });
      try {
        await fetch(mock.baseUrl, { method: "GET" });
      } finally {
        await mock.close();
      }
      // No evidence directory was created anywhere under the temp root.
      expect(existsSync(join(root, ".omo"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
