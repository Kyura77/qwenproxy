import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";

const TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

function createSseResponse(events: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Upstream mock that counts completion calls and lets each call reply differently. */
function setupCountingFetchMock(
  handler: (callIndex: number) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (urlStr.includes("chat.qwen.ai")) {
      if (urlStr.includes("/api/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
          { status: 200 },
        );
      }
      if (!urlStr.includes("/api/v2/chat/completions")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      callIndex += 1;
      return handler(callIndex);
    }
    return originalFetch(input, init);
  };
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCompletionCalls: () => callIndex,
  };
}

function answer(text: string, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    choices: [{ delta: { phase: "answer", content: text } }],
    ...extra,
  })}`;
}

// ─── Integration: the "Tool bash does not exists." stall is auto-retried ───────

test("integration: model answers 'Tool bash does not exists.' with tools declared -> qpx retries and surfaces the tool call", async () => {
  const mock = setupCountingFetchMock((callIndex) => {
    if (callIndex === 1) {
      // First upstream turn: no <tool_call> block, just the hesitation sentence.
      return createSseResponse([answer("Tool bash does not exists.")]);
    }
    // Retry turn: a valid tool call.
    return createSseResponse([
      answer('<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>'),
    ]);
  });

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "list the directory" }],
      }),
    });

    const res = await app.fetch(req);
    assert.equal(res.status, 200);

    assert.equal(
      mock.getCompletionCalls(),
      2,
      "qpx must auto-retry once when the model emits no tool call but talks about a missing tool",
    );

    const body: any = await res.json();
    const message = body.choices[0].message;
    assert.ok(Array.isArray(message.tool_calls), "retry must surface a structured tool_calls array");
    assert.equal(message.tool_calls[0].function.name, "bash");
    assert.equal(body.choices[0].finish_reason, "tool_calls");
  } finally {
    mock.restore();
  }
});

test("integration: plain prose with tools declared is NOT retried", async () => {
  const mock = setupCountingFetchMock(() =>
    createSseResponse([answer("Aqui está a explicação que você pediu, sem ferramentas.")]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "explain something" }],
      }),
    });

    const res = await app.fetch(req);
    assert.equal(res.status, 200);
    assert.equal(mock.getCompletionCalls(), 1, "legitimate prose must not trigger a retry");
    const body: any = await res.json();
    assert.equal(body.choices[0].finish_reason, "stop");
  } finally {
    mock.restore();
  }
});

// ─── Integration: reported prompt_tokens never collapses to the estimate ──────

test("integration: real upstream usage is reported as-is (no retrocede)", async () => {
  const mock = setupCountingFetchMock(() =>
    createSseResponse([
      answer("ok", {
        usage: { input_tokens: 403557, output_tokens: 12, total_tokens: 403569 },
      }),
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.usage.prompt_tokens, 403557);
    assert.equal(
      res.headers.get("x-qwenproxy-context-measurement"),
      "qwen",
      "a real measurement must be flagged as qwen-sourced",
    );
  } finally {
    mock.restore();
  }
});

test("integration: OpenAI-shaped upstream usage is captured (input_tokens -> prompt_tokens)", async () => {
  const mock = setupCountingFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 403557, completion_tokens: 189, total_tokens: 403746 },
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(
      body.usage.prompt_tokens,
      403557,
      "OpenAI-shaped prompt_tokens must not be dropped to 0",
    );
  } finally {
    mock.restore();
  }
});

test("integration: when upstream omits usage, prompt_tokens is NOT fabricated from the estimate", async () => {
  const mock = setupCountingFetchMock(() =>
    createSseResponse([answer("ok")]) // no usage block at all
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    assert.equal(res.status, 200);
    const reported = res.headers.get("x-qwenproxy-context-reported-tokens");
    const estimated = res.headers.get("x-qwenproxy-context-estimated-tokens");
    assert.equal(
      reported,
      "0",
      "reported prompt_tokens must stay 0 (unknown), not fall back to the estimate",
    );
    assert.notEqual(reported, estimated, "reported tokens must not equal the local estimate");
  } finally {
    mock.restore();
  }
});
