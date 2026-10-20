import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const READ_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
];

function callBlock(path: string): string {
  return `<tool_call>{"name": "read_file", "arguments": {"path": "${path}"}}</tool_call>`;
}

// Reproduces logs2.txt 2026-08-09T02:22:30 / 02:23:00:
// "WARN [parser] Dropping tool call: per-turn cap reached { read_file, max 8 }"
// — valid calls beyond the cap were dropped with no visibility into the stream
// summary. They must be tracked distinctly from malformed calls (a cap-drop is
// a VALID call that was intentionally not emitted) and must NOT trigger the
// [SYSTEM CORRECTION] auto-retry (the turn already has emitted calls).
test("T5: per-turn cap drops are tracked as capped, not malformed", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
  });

  const result = parser.feed(
    callBlock("a.txt") + callBlock("b.txt") + callBlock("c.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 2, "only calls up to the cap are emitted");
  assert.strictEqual(parser.getEmittedToolCallCount(), 3, "dropped call counts toward the cap");

  const capped = parser.getCappedToolCalls();
  assert.strictEqual(capped.length, 1, "over-cap call must be tracked");
  assert.strictEqual(capped[0].toolName, "read_file");
  assert.ok(typeof capped[0].timestamp === "number");

  assert.strictEqual(
    parser.getMalformedToolCalls().length,
    0,
    "cap-drops are NOT malformed: no spurious [SYSTEM CORRECTION] auto-retry",
  );
});

test("T5: cap disabled (0) emits everything and tracks nothing", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 0,
  });

  const result = parser.feed(
    callBlock("a.txt") + callBlock("b.txt") + callBlock("c.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 3);
  assert.strictEqual(parser.getCappedToolCalls().length, 0);
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

test("T5: cap-drop does not disturb subsequent text/tool parsing", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 1,
  });

  const result = parser.feed(
    callBlock("a.txt") + "then some text" + callBlock("b.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1, "only the first call is emitted");
  assert.strictEqual(allCalls[0].arguments.path, "a.txt");
  assert.strictEqual(parser.getCappedToolCalls().length, 1);
  assert.strictEqual(parser.getCappedToolCalls()[0].toolName, "read_file");
});

test("T5: isToolCapReached reflects the cap lifecycle", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
  });

  assert.strictEqual(parser.isToolCapReached(), false, "fresh parser is below the cap");

  parser.feed(callBlock("a.txt"));
  assert.strictEqual(parser.isToolCapReached(), false, "one call is below the cap");

  parser.feed(callBlock("b.txt"));
  assert.strictEqual(parser.isToolCapReached(), true, "cap reached at the second call");

  parser.feed(callBlock("c.txt"));
  assert.strictEqual(parser.isToolCapReached(), true, "cap stays reached after drops");
  assert.strictEqual(parser.getCappedToolCalls().length, 1);
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

test("T5: incremental deltas are not emitted beyond the cap", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
    incrementalToolCalls: true,
  });

  const full =
    callBlock("a.txt") +
    callBlock("b.txt") +
    callBlock("c.txt") +
    callBlock("d.txt");

  const seenIndices = new Set<number>();
  for (let i = 0; i < full.length; i += 5) {
    const r = parser.feed(full.slice(i, i + 5));
    for (const d of r.toolCallDeltas) seenIndices.add(d.index);
  }
  parser.flush();

  assert.ok(seenIndices.size > 0, "incremental deltas must be emitted for allowed calls");
  for (const idx of seenIndices) {
    assert.ok(idx < 2, `delta index ${idx} leaked beyond the cap`);
  }
  assert.strictEqual(parser.getCappedToolCalls().length, 2, "calls 3 and 4 are capped");
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

// Reproduces the infinite WebSearch/WebFetch loop from 2026-09-18:
// Qwen-native tool calls (WebSearch, WebFetch) are not in the client's
// declared tools. They are now FORWARDED to the client as structured calls
// (the client may still know the tool — progressive disclosure), but they
// MUST count toward the per-turn cap so isToolCapReached() fires and the
// stream handler cancels the upstream. Without this, the model can generate
// hundreds of undeclared calls without ever hitting the cap.
test("T5: undeclared tool calls count toward the per-turn cap", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 3,
  });

  function undeclaredCall(query: string): string {
    return `<qpx_call>{"name": "WebSearch", "arguments": {"query": "${query}"}}</qpx_call>`;
  }

  assert.strictEqual(parser.isToolCapReached(), false);

  // Feed 4 undeclared tool calls — cap is 3
  const result = parser.feed(
    undeclaredCall("a") + undeclaredCall("b") + undeclaredCall("c") + undeclaredCall("d"),
  );
  parser.flush();

  // Forwarded as structured calls, but never past the cap
  assert.strictEqual(result.toolCalls.length, 3, "only the calls within the cap are emitted");
  assert.strictEqual(result.toolCalls[0].name, "WebSearch");

  // But the cap MUST be reached so the stream handler stops the upstream
  assert.ok(parser.isToolCapReached(), "cap must fire on undeclared tool calls to prevent infinite generation");
  assert.ok(parser.getEmittedToolCallCount() >= 3, "undeclared calls must count toward emittedToolCallCount");
});

test("T5: mix of declared and undeclared calls shares the same cap", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 3,
  });

  // 1 declared + 3 undeclared → cap at 3
  const result = parser.feed(
    callBlock("a.txt") +
    `<qpx_call>{"name": "WebSearch", "arguments": {"query": "test"}}</qpx_call>` +
    `<qpx_call>{"name": "WebFetch", "arguments": {"url": "http://example.com"}}</qpx_call>` +
    `<qpx_call>{"name": "WebSearch", "arguments": {"query": "more"}}</qpx_call>`,
  );
  parser.flush();

  // Declared + forwarded undeclared calls share the cap
  assert.strictEqual(result.toolCalls.length, 3, "cap shared by declared and undeclared calls");
  assert.strictEqual(result.toolCalls[0].name, "read_file");

  // Cap reached via combined count
  assert.ok(parser.isToolCapReached(), "cap must fire from combined declared + undeclared count");
});
