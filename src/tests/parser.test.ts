import { test } from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const TOOLS = [
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

const FLAT_TOOLS = [
  {
    name: "task",
    description: "Spawn a task",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["description", "prompt"],
    },
  },
];

const EDIT_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_text: { type: "string" },
                new_text: { type: "string" },
              },
              required: ["old_text", "new_text"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
];

test("StreamingToolParser: basic tool call", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed(
    'Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>',
  );
  // Text before tool call is held in pendingLeadIn when tools are present
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "t1");
});

test("StreamingToolParser: does not close inside a JSON string", () => {
  const parser = new StreamingToolParser([
    {
      type: "function",
      function: {
        name: "write",
        parameters: {
          type: "object",
          properties: { content: { type: "string" } },
        },
      },
    },
  ]);
  const content = 'const marker = "</tool_call>";';
  const result = parser.feed(
    `<tool_call>${JSON.stringify({
      name: "write",
      arguments: { content },
    })}</tool_call>`,
  );

  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "write");
  assert.strictEqual(result.toolCalls[0].arguments.content, content);
});

test("StreamingToolParser: recovers double-escaped JSON tool calls", () => {
  const parser = new StreamingToolParser(TOOLS);
  const escaped =
    '{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"a.txt\\"}}';
  const result = parser.feed(`<tool_call>${escaped}</tool_call>`);
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "read_file");
  assert.deepStrictEqual(calls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: drops residual environment details after tool calls", () => {
  const parser = new StreamingToolParser();
  const input =
    '<tool_call>{"name":"edit_file","arguments":{"path":"a.txt","edits":[]}}</tool_call>\n</environment_details>\nCurrent time: 2026-07-18T15:26:30-03:00\nWorking directory: /tmp/project\n</environment_details>';

  const result = parser.feed(input);
  const flushed = parser.flush();

  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.strictEqual(result.text + flushed.text, "");
});

test("StreamingToolParser: drops fragmented environment details after tool calls", () => {
  const parser = new StreamingToolParser();
  const input =
    '<tool_call>{"name":"edit_file","arguments":{"path":"a.txt","edits":[]}}</tool_call>\n</environment_details>\nCurrent time: x\n</environment_details>';
  let text = "";
  let toolCalls = 0;

  for (const char of input) {
    const result = parser.feed(char);
    text += result.text;
    toolCalls += result.toolCalls.length;
  }
  text += parser.flush().text;

  assert.strictEqual(toolCalls, 1);
  assert.strictEqual(text, "");
});

test("StreamingToolParser: multiple tool calls", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed(
    '<tool_call>{"name": "t2", "arguments": {}}</tool_call><tool_call>{"name": "t3", "arguments": {}}</tool_call>',
  );
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, "t2");
  assert.strictEqual(result.toolCalls[1].name, "t3");
});

test("StreamingToolParser: fragmented tool call", () => {
  const parser = new StreamingToolParser();

  // Text before partial tag is emitted immediately (no complete tag yet)
  assert.strictEqual(parser.feed("Text <tool_").text, "Text ");
  assert.strictEqual(parser.feed("call>").text, "");
  const final = parser.feed(
    '{"name": "frag", "arguments": {}}</tool_call> trailing',
  );

  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, "frag");
  assert.strictEqual(final.text, "");
});

test("StreamingToolParser: flush partial content", () => {
  const parser = new StreamingToolParser();

  // Partial tag at end - flush should return it as text
  parser.feed("Unfinished tag <tool_");
  assert.strictEqual(parser.flush().text, "<tool_");

  // Incomplete JSON in tool call - flush should NOT robust-recover it:
  // robustParseJSON would balance the unclosed string and stream a
  // fabricated call while skipping the malformed auto-retry. It must be
  // tracked as truncated instead.
  const parser2 = new StreamingToolParser();
  parser2.feed('Broken tool <tool_call>{"name": "healable"');
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 0);
  assert.ok(
    parser2.getMalformedToolCalls().length > 0,
    "truncated payload must be tracked so the auto-retry can correct Qwen",
  );

  // Invalid JSON in tool call - flush drops it (tracked internally for
  // auto-retry) and restores lead-in, without user-facing bridge text
  const parser3 = new StreamingToolParser();
  parser3.feed("Invalid <tool_call>NOT_JSON");
  const flushed2 = parser3.flush();
  assert.ok(
    !flushed2.text.includes("[WARNING:"),
    "must not surface a bridge-authored warning in the reply",
  );
  assert.ok(flushed2.text.includes("Invalid "), "should restore lead-in text");
  assert.strictEqual(flushed2.toolCalls.length, 0);
  assert.ok(
    parser3.getMalformedToolCalls().length > 0,
    "drop must be tracked so the auto-retry can correct Qwen",
  );
});

test("StreamingToolParser: truncated JSON is dropped + tracked (no fabricated recovery)", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed(
    '<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>',
  );
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 0);
  assert.ok(
    parser.getMalformedToolCalls().length > 0,
    "truncated payload must be tracked so the auto-retry can correct Qwen",
  );
});

test("StreamingToolParser: repairs Qwen arguments greater-than typo", () => {
  const parser = new StreamingToolParser(TOOLS);

  const res = parser.feed(
    '<tool_call>{"name":"read_file","arguments>{"path":"a.txt"}}</tool_call>',
  );

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: repairs unquoted arguments key with colon", () => {
  const parser = new StreamingToolParser(TOOLS);

  const res = parser.feed(
    '<tool_call>{"name":"read_file",arguments:{"path":"a.txt"}}</tool_call>',
  );

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: repairs unquoted arguments key with greater-than", () => {
  const parser = new StreamingToolParser(TOOLS);

  const res = parser.feed(
    '<tool_call>{"name":"read_file",arguments>{"path":"a.txt"}}</tool_call>',
  );

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: recovers flattened top-level parameters without arguments wrapper", () => {
  const parser = new StreamingToolParser(TOOLS);

  const res = parser.feed(
    '<tool_call>{"name":"read_file","path":"a.txt"}</tool_call>',
  );

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: truncated flattened write_file is preserved not dropped", () => {
  const writeTools = [
    {
      type: "function" as const,
      function: {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
  ];
  const parser = new StreamingToolParser(writeTools);

  // Emulate a truncated/flattened tool call that would previously be dropped.
  const result = parser.feed(
    `<tool_call>{"name":"write_file","content":"import sqlite3
from datetime import",
"path":"a.py"}</tool_call>`,
  );
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.ok(calls.length >= 1);
  assert.strictEqual(calls[0].name, "write_file");
  assert.ok(calls[0].arguments.path);
});

test("StreamingToolParser: recovers missing opening tag and flattens nested arguments", () => {
  const parser = new StreamingToolParser([
    {
      type: "function",
      function: {
        name: "recovered",
        description: "",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ]);

  const res = parser.feed(
    '{"name": "recovered", "arguments": {"arguments": {"path": "a.txt"}}}</tool_call>',
  );
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "recovered");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: preserves tags in non-tool text", () => {
  const parser = new StreamingToolParser();

  // When it looks like a tool call (has open+close tags), it tries to parse
  // If parse fails, tags are NOT preserved (they're dropped as malformed tool calls)
  const res1 = parser.feed(
    'Fake: <tool_call> { "only_args": 1 } </tool_call> ',
  );
  // Malformed tool call is dropped, lead-in restored (with trailing space)
  assert.strictEqual(res1.text, "Fake:  ");
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, "r");
});

test("StreamingToolParser: handles multiple tool calls in array format", () => {
  const parser = new StreamingToolParser();

  const chunk = `<tool_call>[
  {"name": "bash", "arguments": {"command": "ls", "description": "List files"}},
  {"name": "read", "arguments": {"path": "test.txt"}}
]</tool_call>`;

  const result = parser.feed(chunk);
  assert.strictEqual(
    result.toolCalls.length,
    2,
    "Should extract both tool calls",
  );
  assert.strictEqual(result.toolCalls[0].name, "bash");
  assert.strictEqual(result.toolCalls[1].name, "read");
  assert.strictEqual(result.toolCalls[0].arguments.command, "ls");
});

test("StreamingToolParser: no tool calls emits text normally", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed("Hello, how can I help you today?");
  assert.strictEqual(result.text, "Hello, how can I help you today?");
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: pendingLeadIn cleared after tool call", () => {
  const parser = new StreamingToolParser();

  // After processing a successful tool call, pendingLeadIn is cleared
  parser.feed(
    'Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>',
  );
  assert.strictEqual(parser.getPendingLeadIn(), "");
  assert.strictEqual(parser.getEmittedToolCallCount(), 1);
});

test("StreamingToolParser: preserves literal <tool_call> inside inline code across chunks", () => {
  const parser = new StreamingToolParser(TOOLS);

  const first = parser.feed(
    "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `",
  );
  assert.strictEqual(
    first.text,
    "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `",
  );
  assert.strictEqual(first.toolCalls.length, 0);

  const second = parser.feed("<tool_call>`. A estrutura é sempre esta:");
  assert.strictEqual(second.text, "<tool_call>`. A estrutura é sempre esta:");
  assert.strictEqual(second.toolCalls.length, 0);
});

test("StreamingToolParser: preserves literal <tool_call> example in fenced code block", () => {
  const parser = new StreamingToolParser(TOOLS);

  const literal = [
    "Exemplo:",
    "```json",
    "<tool_call>",
    '{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}',
    "</tool_call>",
    "```",
  ].join("\n");

  const result = parser.feed(literal);
  assert.strictEqual(result.text, literal);
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: forwards undeclared tool_call to the client as a structured call", () => {
  const parser = new StreamingToolParser(TOOLS);

  const literal =
    '<tool_call>{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}</tool_call>';

  const result = parser.feed(literal);
  // A client that defers tools still knows the tool — it just did not advertise
  // it. Neutering the call into prose leaves the client with a dead turn, so the
  // call is forwarded as a real tool_call and the client decides.
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "nome_da_ferramenta");
  assert.deepStrictEqual(result.toolCalls[0].arguments, { parametro: "valor" });
});

test("StreamingToolParser: preserves literal tool_call block when forwarding undeclared calls is disabled", () => {
  const parser = new StreamingToolParser(TOOLS, {
    forwardUndeclaredToolCalls: false,
  });

  const literal =
    '<tool_call>{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}</tool_call>';

  const result = parser.feed(literal);
  assert.strictEqual(result.text, literal);
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: passes through recovered tool call with undeclared name", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    'Lead <tool_call>name": "invented_tool", "arguments": {"path": "a.txt"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "invented_tool");
});

test("StreamingToolParser: accepts declared tool names from flat tool definitions", () => {
  const parser = new StreamingToolParser(FLAT_TOOLS as any);

  const result = parser.feed(
    '<tool_call>{"name":"task","arguments":{"description":"Resume backend analysis","prompt":"Analyze all files"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "task");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    description: "Resume backend analysis",
    prompt: "Analyze all files",
  });
});

test("StreamingToolParser: fuzzy-matches declared tool names safely", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    '<tool_call>{"name":"readFile","arguments":{"path":"src/index.ts"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    path: "src/index.ts",
  });
});

test("StreamingToolParser: parses case-insensitive tool close tags", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</TOOL_CALL>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    path: "package.json",
  });
});

test("StreamingToolParser: parses double-escaped JSON argument strings", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  const escapedEdits = JSON.stringify([
    { old_text: "a", new_text: "b" },
  ]).replaceAll('"', "\\" + '"');
  const payload = `<tool_call>${JSON.stringify({
    name: "edit_file",
    arguments: { path: "src/a.ts", edits: escapedEdits },
  })}</tool_call>`;
  const result = parser.feed(payload);

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments.edits, [
    { old_text: "a", new_text: "b" },
  ]);
});

test("StreamingToolParser: accepts plural tool_calls tags across fragments", () => {
  const parser = new StreamingToolParser(TOOLS);
  const input = [
    '<tool_calls>\n{"name":"read_file","arguments":{"path":"a.txt"}}\n</tool_call>',
    '\n<tool_calls>\n{"name":"read_file","arguments":{"path":"b.txt"}}\n</tool_calls>',
  ].join("");
  let text = "";
  const toolCalls = [] as ReturnType<StreamingToolParser["feed"]>["toolCalls"];

  for (let index = 0; index < input.length; index += 3) {
    const result = parser.feed(input.slice(index, index + 3));
    text += result.text;
    toolCalls.push(...result.toolCalls);
  }
  const flushed = parser.flush();
  text += flushed.text;
  toolCalls.push(...flushed.toolCalls);

  assert.strictEqual(text, "");
  assert.deepStrictEqual(
    toolCalls.map((toolCall) => toolCall.name),
    ["read_file", "read_file"],
  );
  assert.deepStrictEqual(toolCalls.map((toolCall) => toolCall.arguments), [
    { path: "a.txt" },
    { path: "b.txt" },
  ]);
});

test("StreamingToolParser: parses plural Hermes/XML tool calls", () => {
  const parser = new StreamingToolParser(TOOLS);
  const result = parser.feed(
    '<tool_calls name="read_file"><parameter name="path">a.txt</parameter></tool_calls>',
  );
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(result.text + flushed.text, "");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "read_file");
  assert.deepStrictEqual(calls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: parses JSON-stringified nested argument fields", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const edits = [
    {
      old_text:
        "        const streamState = createStreamState(responseId, requestModel);\n        let completionTokens = 0;\n        let streamError: Error | null = null;",
      new_text:
        "        const streamState = createStreamState(responseId, requestModel);\n        let completionTokens = 0;\n        let streamError: Error | null = null;\n        resetTimeout();",
    },
  ];

  const result = parser.feed(
    `<tool_call>${JSON.stringify({
      name: "edit_file",
      arguments: {
        path: "src/routes/responses/index.ts",
        edits: JSON.stringify(edits),
      },
    })}</tool_call>`,
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.strictEqual(
    result.toolCalls[0].arguments.path,
    "src/routes/responses/index.ts",
  );
  assert.deepStrictEqual(result.toolCalls[0].arguments.edits, edits);
});

test("StreamingToolParser: recovers double-encoded JSON string payload (escaped quotes)", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  const doubleEncoded = JSON.stringify({
    name: "edit_file",
    arguments: { path: "src/browser/worker.js", edits: [{ old_text: "a", new_text: "b" }] },
  });
  const result = parser.feed(`<tool_call>"${doubleEncoded}"</tool_call>`);
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(result.text + flushed.text, "");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "edit_file");
  assert.deepStrictEqual(calls[0].arguments.edits, [
    { old_text: "a", new_text: "b" },
  ]);
});

test("StreamingToolParser: recovers tool JSON wrapped in junk text", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  const payload = `<tool_call>block. The client executes it and sends the result back.\\",\\n\\t\\"3. NEVER describe the tool JSON without the tags. ${JSON.stringify({
    name: "edit_file",
    arguments: { path: "src/browser/worker.js", edits: [{ old_text: "a", new_text: "b" }] },
  })}</tool_call>`;
  const result = parser.feed(payload);
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(result.text + flushed.text, "");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "edit_file");
  assert.deepStrictEqual(calls[0].arguments.edits, [
    { old_text: "a", new_text: "b" },
  ]);
});

test("StreamingToolParser: truncated edit_file is dropped + tracked (no brace-balancing fabrication)", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  // Cut mid-string (`"old_text":"start` never closes) — brace-balancing
  // recovery would fabricate a closing quote and stream a broken call while
  // skipping the malformed auto-retry (logs1 2829-char write drop).
  const truncated = `{"name":"edit_file","arguments":{"path":"src/browser/worker.js","edits":[{"old_text":"start`;
  const result = parser.feed(`<tool_call>${truncated}</tool_call>`);
  const flushed = parser.flush();

  const calls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 0);
  assert.ok(
    parser.getMalformedToolCalls().length > 0,
    "truncated payload must be tracked so the auto-retry can correct Qwen",
  );
});

test("StreamingToolParser: flush drops truncated edit_file + tracks malformed", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  const truncated = `{"name":"edit_file","arguments":{"path":"src/browser/worker.js","edits":[{"old_text":"start`;
  parser.feed(`<tool_call>${truncated}`);
  const flushed = parser.flush();

  assert.strictEqual(flushed.toolCalls.length, 0);
  assert.ok(
    parser.getMalformedToolCalls().length > 0,
    "truncated payload must be tracked so the auto-retry can correct Qwen",
  );
});

test("StreamingToolParser: drops duplicate tool calls within the same turn", () => {
  const parser = new StreamingToolParser(TOOLS);

  const block = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
  const result = parser.feed(`${block}${block}`);

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "read_file");
});

test("StreamingToolParser: keeps distinct tool calls with same name but different args", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 2);
  assert.deepStrictEqual(
    result.toolCalls.map((toolCall) => toolCall.arguments),
    [{ path: "a.txt" }, { path: "b.txt" }],
  );
});

test("StreamingToolParser: enforces per-turn tool call cap", () => {
  const parser = new StreamingToolParser(TOOLS, { maxToolCallsPerTurn: 2 });

  const result = parser.feed(
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>' +
      '<tool_call>{"name":"read_file","arguments":{"path":"c.txt"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 2);
  assert.deepStrictEqual(
    result.toolCalls.map((toolCall) => toolCall.arguments),
    [{ path: "a.txt" }, { path: "b.txt" }],
  );
});

test("StreamingToolParser: incremental deltas use resolved name (no duplicate chunk)", () => {
  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });

  const input = '<tool_call>{"name":"readFile","arguments":{"path":"a.txt"}}</tool_call>';
  const deltas: any[] = [];
  const fullCalls: any[] = [];
  for (let index = 0; index < input.length; index += 4) {
    const result = parser.feed(input.slice(index, index + 4));
    deltas.push(...result.toolCallDeltas);
    fullCalls.push(...result.toolCalls);
  }
  const flushed = parser.flush();
  deltas.push(...flushed.toolCallDeltas);
  fullCalls.push(...flushed.toolCalls);

  assert.strictEqual(fullCalls.length, 0, "no complete chunk after streamed deltas");
  const nameDeltas = deltas.filter((delta) => delta.function?.name);
  assert.strictEqual(nameDeltas.length, 1);
  assert.strictEqual(nameDeltas[0].function.name, "read_file");
  const args = deltas.map((delta) => delta.function?.arguments || "").join("");
  assert.strictEqual(args, '{"path":"a.txt"}');
});

test("StreamingToolParser: drops duplicate incremental tool calls before emitting", () => {
  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });

  const input =
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
  const deltas: any[] = [];
  const fullCalls: any[] = [];
  for (let index = 0; index < input.length; index += 4) {
    const result = parser.feed(input.slice(index, index + 4));
    deltas.push(...result.toolCallDeltas);
    fullCalls.push(...result.toolCalls);
  }
  const flushed = parser.flush();
  deltas.push(...flushed.toolCallDeltas);
  fullCalls.push(...flushed.toolCalls);

  assert.strictEqual(fullCalls.length, 0);
  const nameDeltas = deltas.filter((delta) => delta.function?.name);
  assert.strictEqual(nameDeltas.length, 1, "duplicate call deltas must not be emitted");
});

test("StreamingToolParser: recovers tool call with unclosed outer brace and qpx_call closing tag", () => {
  const ASK_TOOLS = [
    {
      name: "AskUserQuestion",
      description: "Ask user",
      parameters: { type: "object", properties: { questions: { type: "array" } } },
    } as any,
  ];
  const parser = new StreamingToolParser(ASK_TOOLS);
  const input = '<qpx_call>\n{"name":"AskUserQuestion","arguments":{"questions":[{"question":"Which port?","options":[{"label":"A"},{"label":"B"}]}]}}\n</qpx_call>';
  // Missing one closing brace: }]}] instead of }]}]}}
  const brokenInput = input.replace(/\}\}\n<\/qpx_call>/, "}\n</qpx_call>");
  const res1 = parser.feed(brokenInput);
  const res2 = parser.flush();
  const allCalls = [...res1.toolCalls, ...res2.toolCalls];
  assert.strictEqual(allCalls.length, 1, "tool call should be successfully parsed");
  assert.strictEqual(allCalls[0].name, "AskUserQuestion");
  assert.strictEqual((allCalls[0].arguments as any).questions[0].question, "Which port?");
});

test("StreamingToolParser: recovers tool call with dropped opening quote before non-alpha characters", () => {
  const EDIT_TOOLS = [
    {
      name: "Edit",
      description: "Edit file",
      parameters: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" } } },
    } as any,
  ];
  const parser = new StreamingToolParser(EDIT_TOOLS);
  const input = '<qpx_call>\n{"name":"Edit","arguments":{"file_path":"test.cs", "old_string":                // MCP\\n                InpPrintState = true;"}}\n</qpx_call>';
  const res1 = parser.feed(input);
  const res2 = parser.flush();
  const allCalls = [...res1.toolCalls, ...res2.toolCalls];
  assert.strictEqual(allCalls.length, 1, "Edit tool call should be successfully parsed");
  assert.strictEqual(allCalls[0].name, "Edit");
  assert.ok((allCalls[0].arguments as any).old_string.includes("// MCP"));
});

test("StreamingToolParser: parses <qpx_call> even after an unclosed stray backtick on an earlier line", () => {
  const BASH_TOOLS = [
    {
      name: "bash",
      description: "Execute bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
      },
    } as any,
  ];
  const parser = new StreamingToolParser(BASH_TOOLS);
  // Exact reproduction of the failure observed in production:
  // model outputs a stray single backtick in lead-in prose, then tool calls on next lines
  const chunk1 = "` tags. Let me explore the Go code.\n";
  const chunk2 = '<qpx_call>\n{"name": "bash", "arguments": {"command": "find . -type f", "timeout": 10000}}\n</qpx_call>';

  const res1 = parser.feed(chunk1);
  const res2 = parser.feed(chunk2);
  const flushed = parser.flush();

  const allCalls = [...res1.toolCalls, ...res2.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1, "tool call must be parsed despite earlier stray backtick");
  assert.strictEqual(allCalls[0].name, "bash");
  assert.strictEqual((allCalls[0].arguments as any).command, "find . -type f");
  // No raw <qpx_call> tags must leak to client text
  const totalText = res1.text + res2.text + flushed.text;
  assert.ok(!totalText.includes("<qpx_call>"), "raw <qpx_call> must never leak in client text");
});

test("StreamingToolParser: heals truncated tool call when prior tool calls were already emitted", () => {
  const SPAWN_TOOLS = [
    {
      name: "tool1",
      description: "first tool",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    } as any,
    {
      name: "spawn_agent",
      description: "spawn an agent",
      parameters: {
        type: "object",
        properties: { label: { type: "string" }, message: { type: "string" } },
      },
    } as any,
  ];

  const parser = new StreamingToolParser(SPAWN_TOOLS, { incrementalToolCalls: true });

  // Step 1: Tool call 1 finishes cleanly
  const chunk1 = '<qpx_call>\n{"name": "tool1", "arguments": {"path": "test.txt"}}\n</qpx_call>\n';
  const res1 = parser.feed(chunk1);
  assert.strictEqual(parser.getEmittedToolCallCount(), 1, "first tool call should be emitted");

  // Step 2: Tool call 2 starts and gets cut off mid-string at end of stream (exact production failure)
  const chunk2 = '<qpx_call>\n{"name": "spawn_agent", "arguments": {"label": "audit-vvrn", "message": "Você é um Senior Minecraft AntiCheat Engineer auditando um anticheat';
  const res2 = parser.feed(chunk2);

  // Step 3: Stream ends, flush is called
  const flushed = parser.flush();

  // Collect all toolCallDeltas emitted across all chunks for tool index 1
  const allDeltas = [...res1.toolCallDeltas, ...res2.toolCallDeltas, ...flushed.toolCallDeltas];
  const tool1Deltas = allDeltas.filter((d) => d.index === 1);

  const accumulatedArgs = tool1Deltas.map((d) => d.function.arguments || "").join("");
  assert.ok(accumulatedArgs.length > 0, "arguments must be streamed to client");

  // Crucial invariant: The accumulated arguments must be VALID, parseable JSON on client side
  let parsedClientArgs: any;
  assert.doesNotThrow(() => {
    parsedClientArgs = JSON.parse(accumulatedArgs);
  }, "client must not encounter SyntaxError: Unexpected end of JSON input");
  assert.strictEqual(parsedClientArgs.label, "audit-vvrn");
  assert.ok(parsedClientArgs.message.startsWith("Você é um Senior"));
  assert.ok(
    parsedClientArgs.message.includes("TRUNCATED BY UPSTREAM MODEL OUTPUT LIMIT"),
    "prompt must carry truncation warning so subagent knows it was cut off",
  );
  assert.strictEqual(parser.getEmittedToolCallCount(), 2, "both tool calls must be finalized");
});

test("StreamingToolParser: write_file truncation injects explicit code comment warning", () => {
  const WRITE_TOOLS = [
    {
      name: "tool1",
      description: "first tool",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    } as any,
    {
      name: "write_file",
      description: "write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    } as any,
  ];

  const parser = new StreamingToolParser(WRITE_TOOLS, { incrementalToolCalls: true });
  parser.feed('<qpx_call>\n{"name": "tool1", "arguments": {"path": "test.txt"}}\n</qpx_call>\n');
  parser.feed('<qpx_call>\n{"name": "write_file", "arguments": {"path": "src/main.rs", "content": "fn main() {\\n    let a = 10;');
  const flushed = parser.flush();

  const allDeltas = flushed.toolCallDeltas.filter((d) => d.index === 1);
  const accumulatedArgs = allDeltas.map((d) => d.function.arguments || "").join("");
  const parsed = JSON.parse(accumulatedArgs);
  assert.ok(
    parsed.content.includes("/* [TRUNCATED BY UPSTREAM MODEL OUTPUT LIMIT"),
    "truncated file content must carry code comment warning so agent does not treat it as complete",
  );
});

test("StreamingToolParser: bash truncation injects exit 1 guard to prevent dangerous execution", () => {
  const BASH_TOOLS = [
    {
      name: "tool1",
      description: "first tool",
      parameters: { type: "object" },
    } as any,
    {
      name: "bash",
      description: "run bash",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    } as any,
  ];

  const parser = new StreamingToolParser(BASH_TOOLS, { incrementalToolCalls: true });
  parser.feed('<qpx_call>\n{"name": "tool1", "arguments": {}}\n</qpx_call>\n');
  parser.feed('<qpx_call>\n{"name": "bash", "arguments": {"command": "find /var/log -type f');
  const flushed = parser.flush();

  const allDeltas = flushed.toolCallDeltas.filter((d) => d.index === 1);
  const accumulatedArgs = allDeltas.map((d) => d.function.arguments || "").join("");
  const parsed = JSON.parse(accumulatedArgs);
  assert.ok(
    parsed.command.includes("exit 1"),
    "truncated bash command must append exit 1 so shell fails safely instead of running incomplete command",
  );
});

test("StreamingToolParser: recovers edit_file with missing opening quote on property key (e.g. ,old_text:)", () => {
  const EDIT_TOOLS = [
    {
      name: "edit_file",
      description: "edit file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, edits: { type: "array" } },
      },
    } as any,
  ];
  const parser = new StreamingToolParser(EDIT_TOOLS);
  // Exact pattern from production logs:
  const brokenInput =
    '<qpx_call>\n{"name":"edit_file","arguments":{"edits":[{"new_text":"new",old_text":"old"}],"path":"file.java"}}\n</qpx_call>';
  const res = parser.feed(brokenInput);
  const flushed = parser.flush();
  const calls = [...res.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 1, "tool call with missing quote on key must be repaired");
  assert.strictEqual(calls[0].name, "edit_file");
  assert.deepStrictEqual((calls[0].arguments as any).edits, [{ new_text: "new", old_text: "old" }]);
});

test("StreamingToolParser: parses <function=name><parameter=key>value</parameter></function> shorthand format", () => {
  const parser = new StreamingToolParser(TOOLS);
  const input =
    "<function=read_file>\n<parameter=path>src/index.ts</parameter>\n</function>";
  const res = parser.feed(input);
  const flushed = parser.flush();
  const calls = [...res.toolCalls, ...flushed.toolCalls];

  assert.strictEqual(calls.length, 1, "function shorthand format should be parsed");
  assert.strictEqual(calls[0].name, "read_file");
  assert.deepStrictEqual(calls[0].arguments, { path: "src/index.ts" });
});

test("StreamingToolParser: parses function shorthand with named parameter tags", () => {
  const parser = new StreamingToolParser(TOOLS);
  const input =
    '<function=read_file>\n<parameter name="path">src/app.ts</parameter>\n</function>';
  const res = parser.feed(input);
  const flushed = parser.flush();
  const calls = [...res.toolCalls, ...flushed.toolCalls];

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "read_file");
  assert.deepStrictEqual(calls[0].arguments, { path: "src/app.ts" });
});

test("StreamingToolParser: parses <function=name> when streamed in small chunks (partial open tag)", () => {
  const parser = new StreamingToolParser(TOOLS);
  const input =
    "<function=read_file>\n<parameter=path>src/index.ts</parameter>\n</function>";
  let text = "";
  const toolCalls: any[] = [];
  for (let i = 0; i < input.length; i += 3) {
    const res = parser.feed(input.slice(i, i + 3));
    text += res.text;
    toolCalls.push(...res.toolCalls);
  }
  const flushed = parser.flush();
  text += flushed.text;
  toolCalls.push(...flushed.toolCalls);

  assert.strictEqual(text, "");
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, "read_file");
  assert.deepStrictEqual(toolCalls[0].arguments, { path: "src/index.ts" });
});

