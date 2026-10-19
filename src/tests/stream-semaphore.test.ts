// Integration test: verifies that multiple streams on one account run
// concurrently without blocking (unlimited streams per account).
import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { createQwenStream } from "../services/qwen.ts";
function createMockStreamResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("data: [DONE]\n\n"),
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installMockFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/v2/chat/completions")) {
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const ACCOUNT = "stream-semaphore-test";

test("multiple streams run CONCURRENTLY on one account (unlimited)", async () => {
  const restoreFetch = installMockFetch();
  try {
    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT,
    );
    const second = await Promise.race([
      createQwenStream("Prompt 2", true, "qwen3.6-plus", undefined, ACCOUNT),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("second stream blocked behind a serialized stream lock"),
            ),
          3_000,
        ),
      ),
    ]);
    const third = await Promise.race([
      createQwenStream("Prompt 3", true, "qwen3.6-plus", undefined, ACCOUNT),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("third stream blocked behind a serialized stream lock"),
            ),
          3_000,
        ),
      ),
    ]);
    await first.stream.cancel();
    await second.stream.cancel();
    await third.stream.cancel();
  } finally {
    restoreFetch();
  }
});
