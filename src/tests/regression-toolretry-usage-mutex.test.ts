import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const { Mutex } = await import("../core/mutex.ts");
const { createUsageAccumulator, applyUpstreamUsage, buildUsage } = await import(
  "../routes/chat/helpers.ts"
);
const { enrichUsageWithContextMeter } = await import("../services/context-meter.ts");
const { decideMissingToolCallRetry, isToolHesitationText } = await import(
  "../tools/tool-call-heuristics.ts"
);

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Mutex: force-release must invalidate the evicted holder's handle ─────────

test("Mutex: late release from a force-released holder must not clear the new holder", async () => {
  const m = new Mutex("regression-stale-release", 50); // 50ms hold limit

  const leaked = await m.acquire(1000, "leaked");
  assert.equal(m.state().heldBy, "leaked");

  // Let the lock go stale so the next acquire force-releases it.
  await tick(70);
  const fresh = await m.acquire(500, "fresh");
  assert.equal(m.state().locked, true);
  assert.equal(m.state().heldBy, "fresh");

  // The evicted holder finally releases. This MUST be a no-op: the lock is
  // owned by `fresh` now and must not be cleared underneath it.
  leaked();
  assert.equal(m.state().locked, true, "new holder lock must survive stale release");
  assert.equal(m.state().heldBy, "fresh");

  // A third acquire must NOT be able to steal the still-held lock.
  let stolen = false;
  const waiter = m.acquire(40, "thief").then((r) => {
    stolen = true;
    return r;
  });
  await assert.rejects(() => waiter, /acquire timeout/);
  assert.equal(stolen, false, "no double-grant while the new holder is active");

  fresh();
  assert.equal(m.isIdle(), true);
});

test("Mutex: normal acquire/release hand-off is unaffected", async () => {
  const m = new Mutex("regression-normal", 50);
  const a = await m.acquire(1000, "a");
  const bPromise = m.acquire(1000, "b");
  await tick(10);
  a();
  const b = await bPromise;
  assert.equal(m.state().heldBy, "b");
  b();
  assert.equal(m.isIdle(), true);
});

// ─── Usage: accept both upstream shapes ──────────────────────────────────────

test("applyUpstreamUsage: recognises OpenAI prompt_tokens/completion_tokens", () => {
  const acc = createUsageAccumulator(0);
  applyUpstreamUsage(acc, { prompt_tokens: 403557, completion_tokens: 189 });
  const usage = buildUsage(acc);
  assert.equal(usage.prompt_tokens, 403557);
  assert.equal(usage.completion_tokens, 189);
});

test("applyUpstreamUsage: still recognises Qwen input_tokens/output_tokens", () => {
  const acc = createUsageAccumulator(0);
  applyUpstreamUsage(acc, { input_tokens: 403557, output_tokens: 189 });
  const usage = buildUsage(acc);
  assert.equal(usage.prompt_tokens, 403557);
  assert.equal(usage.completion_tokens, 189);
});

// ─── Context meter: never fabricate prompt_tokens from the estimate ──────────

function snapshot(estimated: number) {
  return {
    estimatedContextTokens: estimated,
    contextWindowTokens: 1_000_000,
  } as any;
}

test("enrichUsageWithContextMeter: no real measurement keeps prompt_tokens untouched (no retrocede)", () => {
  const usage = buildUsage(createUsageAccumulator(0)); // prompt_tokens 0, unknown
  const out: any = enrichUsageWithContextMeter(usage, snapshot(4500), {
    enabled: true,
    reportUsage: true,
  } as any);
  assert.equal(out.prompt_tokens, 0, "must not fabricate 4500 from the estimate");
  assert.equal(out.context_meter.estimatedContextTokens, 4500);
  assert.equal(out.context_meter.reportedPromptTokens, 0);
  assert.equal(out.context_meter.measurementSource, "local_estimate");
});

test("enrichUsageWithContextMeter: a real measurement is reported verbatim", () => {
  const acc = createUsageAccumulator(0);
  applyUpstreamUsage(acc, { input_tokens: 403557, output_tokens: 189 });
  const out: any = enrichUsageWithContextMeter(buildUsage(acc), snapshot(4500), {
    enabled: true,
    reportUsage: true,
  } as any);
  assert.equal(out.prompt_tokens, 403557);
  assert.equal(out.context_meter.measurementSource, "qwen");
});

// ─── Tool-call recovery heuristic ────────────────────────────────────────────

test("isToolHesitationText: matches the 'Tool X does not exists' stall", () => {
  assert.equal(isToolHesitationText("Tool bash does not exists."), true);
  assert.equal(isToolHesitationText("Tool read does not exist."), true);
  assert.equal(isToolHesitationText("tool write doesn't exist"), true);
  assert.equal(isToolHesitationText("Here is the answer you asked for."), false);
  assert.equal(isToolHesitationText(""), false);
});

test("decideMissingToolCallRetry: hesitation with no emitted block retries", () => {
  const d = decideMissingToolCallRetry({
    declaredToolCount: 5,
    successfulToolCallCount: 0,
    malformedToolCallCount: 0,
    emittedToolCallCount: 0,
    text: "Tool bash does not exists.",
  });
  assert.deepEqual(d, { retry: true, reason: "no_call" });
});

test("decideMissingToolCallRetry: malformed block keeps existing behaviour", () => {
  const d = decideMissingToolCallRetry({
    declaredToolCount: 5,
    successfulToolCallCount: 0,
    malformedToolCallCount: 2,
    emittedToolCallCount: 2,
    text: "",
  });
  assert.deepEqual(d, { retry: true, reason: "malformed" });
});

test("decideMissingToolCallRetry: no tools / success / plain prose never retry", () => {
  assert.equal(
    decideMissingToolCallRetry({
      declaredToolCount: 0,
      successfulToolCallCount: 0,
      malformedToolCallCount: 0,
      emittedToolCallCount: 0,
      text: "Tool bash does not exists.",
    }).retry,
    false,
  );
  assert.equal(
    decideMissingToolCallRetry({
      declaredToolCount: 5,
      successfulToolCallCount: 1,
      malformedToolCallCount: 0,
      emittedToolCallCount: 1,
      text: "done",
    }).retry,
    false,
  );
  assert.equal(
    decideMissingToolCallRetry({
      declaredToolCount: 5,
      successfulToolCallCount: 0,
      malformedToolCallCount: 0,
      emittedToolCallCount: 0,
      text: "Here is a normal answer with no tool use.",
    }).retry,
    false,
  );
});
