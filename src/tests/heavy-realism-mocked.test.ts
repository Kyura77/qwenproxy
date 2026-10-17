import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";
import { Mutex } from "../core/mutex.js";

// ─────────────────────────────────────────────────────────────────────────────
// Heavy, realistic mocked harness. The upstream (chat.qwen.ai) is a stateful
// mock that speaks the same SSE dialect as the real service: thinking phase,
// answer phase, and top-level `usage` blocks in Qwen (input_tokens) / OpenAI
// (prompt_tokens) shapes, optionally missing altogether. We drive the real
// proxy `app` over HTTP exactly as a client (omp / opencode) would.
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
];

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sse(events: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc(`${e}\n\n`));
      controller.enqueue(enc("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** One SSE event carrying a delta plus an optional top-level usage block. */
function ev(delta: Record<string, unknown>, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) })}`;
}

function thinking(text: string): string {
  return ev({ phase: "thinking_summary", extra: { summary_thought: { content: [text] } } });
}

function answer(text: string, usage?: Record<string, unknown>): string {
  return ev({ phase: "answer", content: text }, usage);
}

/** A realistic upstream turn: a thinking phase, then the answer/tool call. */
function turn(body: string, usage?: Record<string, unknown>): Response {
  return sse([thinking("Analisando o pedido do usuário…"), answer(body, usage)]);
}

type UpstreamHandler = (
  reqBody: any,
  callIndex: number,
) => Response | Promise<Response>;

/** Intercepts every chat.qwen.ai call; a generic 200 covers init/waf/session routes. */
function installUpstream(handler: UpstreamHandler) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (!url.includes("chat.qwen.ai")) return originalFetch(input, init);
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }), { status: 200 });
    }
    if (!url.includes("/api/v2/chat/completions")) {
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }
    callIndex += 1;
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }
    return handler(body, callIndex);
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    calls: () => callIndex,
  };
}

async function chat(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: "qwen3.6-plus", ...payload }),
    }),
  );
}

async function collectStream(res: Response): Promise<{ text: string; toolCalls: any[]; finishReason: string | null; usage: any }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls: any[] = [];
  let finishReason: string | null = null;
  let usage: any = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message ?? {};
      if (typeof delta.content === "string") text += delta.content;
      if (Array.isArray(delta.tool_calls)) toolCalls.push(...delta.tool_calls);
    }
  }
  return { text, toolCalls, finishReason, usage };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Concurrent multi-session / multi-provider burst
// ─────────────────────────────────────────────────────────────────────────────

test("heavy: 24 concurrent clients (mixed sessions, providers, stream) — all 200, no hang", { timeout: 60_000 }, async () => {
  const seenSessions = new Set<string>();
  const mock = installUpstream((body) => {
    const content = body?.messages?.slice(-1)?.[0]?.content ?? "";
    return turn(`resposta para: ${String(content).slice(0, 24)}`, {
      input_tokens: 1000 + String(content).length,
      output_tokens: 5,
      total_tokens: 1005 + String(content).length,
    });
  });

  try {
    const jobs: Promise<any>[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 24; i++) {
      const isStream = i % 2 === 0;
      // Half of the odd clients deliberately collide on one session id.
      const sessionId = i % 4 === 0 ? `sess_collide` : `sess_${i}`;
      seenSessions.add(sessionId);
      const headers: Record<string, string> = { "x-session-id": sessionId };
      // Two "providers" differ only by system prompt (opencode vs omp).
      const provider = i % 3 === 0 ? "opencode" : "omp";
      const payload = {
        stream: isStream,
        messages: [
          { role: "system", content: `Você é o assistente ${provider}.` },
          { role: "user", content: `pedido #${i} do provider ${provider}` },
        ],
      };
      jobs.push(
        chat(payload, headers).then(async (res) => {
          assert.equal(res.status, 200, `client ${i} status`);
          if (isStream) {
            const out = await collectStream(res);
            assert.ok(out.text.length > 0, `client ${i} stream text`);
          } else {
            const b: any = await res.json();
            assert.ok(b.choices?.[0]?.message, `client ${i} body`);
          }
          return res;
        }),
      );
    }
    await Promise.all(jobs);
    const dt = performance.now() - t0;
    assert.ok(mock.calls() >= 24, `expected >=24 upstream calls, got ${mock.calls()}`);
    console.log(`   ↳ 24 clients served in ${dt.toFixed(0)}ms (${mock.calls()} upstream calls, ${seenSessions.size} session ids)`);
  } finally {
    mock.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Realistic agentic tool loop (6 turns), token accounting must hold
// ─────────────────────────────────────────────────────────────────────────────

test("heavy: 6-turn agentic tool loop — completes, real usage preserved every turn", { timeout: 60_000 }, async () => {
  const REAL = (turnNo: number, payloadLen: number) => 5000 + turnNo * 12000 + payloadLen;
  const mock = installUpstream((body, callIndex) => {
    const msgs = body?.messages ?? [];
    const hasToolResult = msgs.some((m: any) => m.role === "tool");
    const payloadLen = JSON.stringify(msgs).length;
    const usage = { input_tokens: REAL(callIndex, payloadLen), output_tokens: 40, total_tokens: REAL(callIndex, payloadLen) + 40 };
    if (!hasToolResult) {
      return turn('<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>', usage);
    }
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount < 3) {
      return turn('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>', usage);
    }
    return turn("Tarefa concluída.", usage);
  });

  try {
    const messages: any[] = [{ role: "user", content: "explore o projeto e resuma" }];
    const reported: number[] = [];
    let turns = 0;
    for (let i = 0; i < 8; i++) {
      const res = await chat({ stream: false, tools: TOOLS, messages });
      assert.equal(res.status, 200);
      const b: any = await res.json();
      turns++;
      const usage = b.usage ?? {};
      const header = Number(res.headers.get("x-qwenproxy-context-reported-tokens") ?? "-1");
      // Real upstream usage must survive untouched — never the heuristic estimate.
      assert.ok(usage.prompt_tokens >= 5000, `turn ${i} real prompt_tokens preserved (got ${usage.prompt_tokens})`);
      assert.equal(header, usage.prompt_tokens, `turn ${i} header matches body`);
      assert.equal(res.headers.get("x-qwenproxy-context-measurement"), "qwen", `turn ${i} measured by qwen`);
      reported.push(usage.prompt_tokens);

      const msg = b.choices[0].message;
      messages.push(msg);
      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: `ok:${tc.function.name}` });
        }
        continue;
      }
      break;
    }
    assert.ok(turns >= 3, `loop must run multiple turns (ran ${turns})`);
    // Token counts should trend up as the transcript grows (no retrocede to a tiny estimate).
    for (let i = 1; i < reported.length; i++) {
      assert.ok(reported[i] > reported[i - 1], `reported tokens must not collapse (turn ${i}: ${reported[i - 1]} -> ${reported[i]})`);
    }
    console.log(`   ↳ loop completed in ${turns} turns; prompt_tokens: ${reported.join(" -> ")}`);
  } finally {
    mock.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Usage-shape mix across a session (the exact retrocede trigger)
// ─────────────────────────────────────────────────────────────────────────────

test("heavy: alternating usage shapes/missing across a session — reported follows upstream, never the estimate", { timeout: 60_000 }, async () => {
  const plan: Array<Record<string, unknown> | null> = [
    { input_tokens: 403557, output_tokens: 12, total_tokens: 403569 }, // qwen real
    null,                                                             // upstream omitted usage
    { prompt_tokens: 383428, completion_tokens: 30, total_tokens: 383458 }, // openai shape
    null,
    { input_tokens: 345550, output_tokens: 9, total_tokens: 345559 },       // qwen real
  ];
  const mock = installUpstream((_body, i) => turn("ok", plan[Math.min(i - 1, plan.length - 1)] ?? undefined));

  try {
    const expected = [403557, 0, 383428, 0, 345550];
    const reported: number[] = [];
    const estimates: number[] = [];
    for (let i = 0; i < plan.length; i++) {
      const res = await chat({ stream: false, messages: [{ role: "user", content: `turno ${i} com um pouco de contexto para estimar` }] });
      assert.equal(res.status, 200);
      const b: any = await res.json();
      const header = Number(res.headers.get("x-qwenproxy-context-reported-tokens"));
      const est = Number(res.headers.get("x-qwenproxy-context-estimated-tokens"));
      assert.equal(b.usage.prompt_tokens, expected[i], `turn ${i}: reported prompt_tokens`);
      assert.equal(header, expected[i], `turn ${i}: header reported`);
      if (expected[i] === 0) {
        assert.notEqual(header, est, `turn ${i}: must NOT fall back to the estimate (${est})`);
      }
      reported.push(header);
      estimates.push(est);
    }
    console.log(`   ↳ reported:   ${reported.join(" -> ")}`);
    console.log(`   ↳ estimates:  ${estimates.join(" -> ")}`);
  } finally {
    mock.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The "Tool X does not exists." stall, both stream and non-stream
// ─────────────────────────────────────────────────────────────────────────────

for (const stream of [false, true]) {
  test(`heavy: stall recovery (${stream ? "stream" : "non-stream"}) — hesitation is auto-retried`, { timeout: 30_000 }, async () => {
    const mock = installUpstream((_body, i) => {
      if (i === 1) return turn("Tool read does not exists.");
      return turn('<tool_call>{"name":"read","arguments":{"path":"src/index.ts"}}</tool_call>');
    });
    try {
      const res = await chat({ stream, tools: TOOLS, messages: [{ role: "user", content: "leia o arquivo principal" }] });
      assert.equal(res.status, 200);
      if (stream) {
        const out = await collectStream(res);
        assert.equal(out.finishReason, "tool_calls");
        assert.equal(out.toolCalls.length, 1);
        assert.equal(out.toolCalls[0].function.name, "read");
      } else {
        const b: any = await res.json();
        assert.equal(b.choices[0].finish_reason, "tool_calls");
        assert.equal(b.choices[0].message.tool_calls[0].function.name, "read");
      }
      assert.equal(mock.calls(), 2, "exactly one retry must recover the stall");
    } finally {
      mock.restore();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Heavy personalization: large system prompts (10KB → 500KB)
// ─────────────────────────────────────────────────────────────────────────────

test("heavy: 8 large personalizations (10KB→480KB, sent out-of-band) — served, real usage preserved, no retrocede", { timeout: 120_000 }, async () => {
  // Personalization does NOT travel inside the chat `messages`: the proxy syncs it
  // to the browser/WAF page state out-of-band, so the upstream `input_tokens` does
  // not scale with the system-prompt size. The invariant under test is that the
  // reported (real) usage survives untouched and never collapses to the estimate,
  // and that the payload guard still answers over-cap requests with an explicit 400.
  const mock = installUpstream((body) => {
    const bytes = JSON.stringify(body?.messages ?? []).length;
    return turn("ok", { input_tokens: bytes, output_tokens: 3, total_tokens: bytes + 3 });
  });
  try {
    const sizes = [10, 50, 120, 250, 350, 480].map((kb) => kb * 1024);
    const filler = "Regra de contexto extensa para validar sincronização de personalização. ";
    const results: Array<{ kb: number; reported: number; est: number }> = [];
    for (let i = 0; i < sizes.length; i++) {
      const target = sizes[i];
      const repeats = Math.ceil(target / Buffer.byteLength(filler));
      const system = `=== PERSONA #${i} ===\n` + filler.repeat(repeats).slice(0, target);
      const res = await chat({
        stream: false,
        messages: [{ role: "system", content: system }, { role: "user", content: `tarefa ${i}` }],
      }, { "x-session-id": `perso_${i}` });
      assert.equal(res.status, 200, `size ${target} status`);
      const reported = Number(res.headers.get("x-qwenproxy-context-reported-tokens"));
      const est = Number(res.headers.get("x-qwenproxy-context-estimated-tokens"));
      const b: any = await res.json();
      assert.equal(b.usage.prompt_tokens, reported, `size ${target} body/header agree`);
      assert.ok(reported > 0, `size ${target} real usage present`);
      if (est > 0) assert.notEqual(reported, est, `size ${target} reported must not equal the estimate`);
      results.push({ kb: Math.round(target / 1024), reported, est });
    }
    for (const r of results) console.log(`   ↳ ${String(r.kb).padStart(3)}KB → reported=${r.reported} estimate=${r.est}`);

    // Over the QWEN_MAX_PERSONALIZATION_BYTES (500000) cap: the guard must answer
    // with an explicit, actionable 400 instead of corrupting the upstream call.
    const over = 520 * 1024;
    const overSystem = `=== TOO BIG ===\n` + filler.repeat(Math.ceil(over / Buffer.byteLength(filler))).slice(0, over);
    const overRes = await chat({ stream: false, messages: [{ role: "system", content: overSystem }, { role: "user", content: "x" }] });
    assert.equal(overRes.status, 400, "over-cap personalization must be rejected");
    const overBody: any = await overRes.json();
    assert.match(overBody.error.message, /personalization payload limit/i);
    console.log(`   ↳ 520KB (over cap) → 400 ${JSON.stringify(overBody.error.code)} (guard intact)`);
  } finally {
    mock.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Mutex under heavy contention + injected stale (leaked) holders
// ─────────────────────────────────────────────────────────────────────────────

test("heavy: mutex 60-way contention + evicted-holder late release — never double-grants", { timeout: 30_000 }, async () => {
  const mutex = new Mutex("heavy", 30); // 30ms hold limit → easy to force stale
  let active = 0;
  let maxActive = 0;
  const violations: string[] = [];

  const critical = async (id: number) => {
    const release = await mutex.acquire(10_000, `key-${id}`);
    active++;
    maxActive = Math.max(maxActive, active);
    if (active > 1) violations.push(`active=${active} at ${id}`);
    await sleep(1);
    active--;
    release();
  };

  // Holder A takes the lock and then goes stale (leaked). The first contender's
  // acquire() force-releases it (epoch++), making A's handle inert.
  const releaseA = await mutex.acquire(10_000, "A");
  await sleep(60);

  const contenders = Array.from({ length: 60 }, (_, i) => critical(i));
  // The evicted holder releases *after* the lock has been re-granted — it must be a no-op.
  setTimeout(() => releaseA(), 5);

  await Promise.all(contenders);
  assert.deepEqual(violations, [], "the mutex must never be held by two callers at once");
  assert.equal(maxActive, 1, "exactly one holder at all times");
  assert.ok(mutex.isIdle(), "mutex must drain back to idle (no leaked/bypassed state)");
  console.log(`   ↳ 60 contenders + 1 evicted late release; max concurrent holders = ${maxActive}`);
});
