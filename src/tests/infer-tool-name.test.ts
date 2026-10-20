import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const DECLARED_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "Agent",
      description: "Run subagent",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Bash",
      description: "Run shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Edit",
      description: "Edit file",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["file_path"],
      },
    },
  },
];

test("StreamingToolParser: recovers tool call where Qwen omitted the name property but provided command argument", () => {
  const parser = new StreamingToolParser(DECLARED_TOOLS);

  // Exact payload structure from logs where the model emitted {"arguments": {"command": "..."}} without "name"
  const rawPayload =
    '<tool_call>{"arguments": {"command": "echo \\"=== FULL HEADER AUDIT ===\\""}}</tool_call>';

  const result = parser.feed(rawPayload);
  parser.flush();

  assert.strictEqual(result.toolCalls.length, 1, "Must recover the tool call");
  assert.strictEqual(result.toolCalls[0].name, "Bash", "Must infer Bash from command argument");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    command: 'echo "=== FULL HEADER AUDIT ==="',
  });
  assert.strictEqual(parser.getMalformedToolCalls().length, 0, "Must not be tracked as malformed");
});

test("StreamingToolParser: recovers tool call with flattened command argument without name", () => {
  const parser = new StreamingToolParser(DECLARED_TOOLS);

  const rawPayload =
    '<tool_call>{"command": "git status"}</tool_call>';

  const result = parser.feed(rawPayload);
  parser.flush();

  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "Bash");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    command: "git status",
  });
});

test("StreamingToolParser: fuzzy matches tool name across casing and delimiters (bash -> Bash, read_file -> readFile)", () => {
  const claudeTools = [
    {
      type: "function" as const,
      function: {
        name: "Bash",
        description: "Run shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "readFile",
        description: "Read file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];

  const parser = new StreamingToolParser(claudeTools);
  const chunk1 = '<tool_call>{"name": "bash", "arguments": {"command": "npm test"}}</tool_call>';
  const res1 = parser.feed(chunk1);
  parser.flush();

  assert.strictEqual(res1.toolCalls.length, 1);
  assert.strictEqual(res1.toolCalls[0].name, "Bash", "Must normalize casing to declared Bash");
  assert.strictEqual(parser.getSuccessfulToolCallCount(), 1);

  const chunk2 = '<tool_call>{"name": "read_file", "arguments": {"path": "foo.txt"}}</tool_call>';
  const res2 = parser.feed(chunk2);
  parser.flush();

  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, "readFile", "Must normalize snake_case to declared readFile");
});

test("StreamingToolParser: undeclared tool call is forwarded to the client (not neutered into prose)", () => {
  const customTools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ];

  const parser = new StreamingToolParser(customTools);
  const chunk = '<tool_call>{"name": "totally_random_fake_tool", "arguments": {}}</tool_call>';
  const res = parser.feed(chunk);
  parser.flush();

  // Forwarded: the client may still know the tool (progressive disclosure) and
  // can execute it or return a proper "unknown tool" error result. Preserving it
  // as prose leaves the client with a dead turn and no feedback.
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "totally_random_fake_tool");
  assert.strictEqual(res.text, "", "raw tool-call block must not leak into the visible text");
  assert.strictEqual(parser.getSuccessfulToolCallCount(), 1, "forwarded call counts as a usable call");
  assert.strictEqual(parser.getMalformedToolCalls().length, 0, "a forwarded call is not a malformed call");
});

test("StreamingToolParser: undeclared tool call is recorded as malformed when forwarding is disabled", () => {
  const customTools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ];

  const parser = new StreamingToolParser(customTools, {
    forwardUndeclaredToolCalls: false,
  });
  const chunk = '<tool_call>{"name": "totally_random_fake_tool", "arguments": {}}</tool_call>';
  const res = parser.feed(chunk);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 0);
  assert.strictEqual(parser.getSuccessfulToolCallCount(), 0, "Undeclared tool must NOT increment successful count");
  assert.strictEqual(parser.getMalformedToolCalls().length, 1, "Must record as malformed/undeclared call");
});

