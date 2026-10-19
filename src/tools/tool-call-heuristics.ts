/**
 * Heuristics for deciding whether a turn that produced NO (successful) tool
 * call should be auto-retried.
 *
 * The existing retry path only fires when a `<tool_call>` block was emitted
 * but could not be parsed (malformed / undeclared). It does NOT cover the case
 * where the model emits no tool-call block at all and instead answers with
 * prose that references tools as if they were missing, e.g.:
 *
 *   "Tool bash does not exists."
 *   "Tool read does not exists."
 *
 * In that case the client sees `finish_reason: "stop"` with no `tool_calls`,
 * ends its turn, and the loop stalls until a human nudges it ("continue").
 */

export type MissingToolCallReason = "malformed" | "no_call" | "json_in_text" | null;

export interface MissingToolCallInput {
  /** Number of tool definitions declared on the request. */
  declaredToolCount: number;
  /** Tool calls that parsed AND resolved to a declared tool. */
  successfulToolCallCount: number;
  /** `<tool_call>` blocks captured but rejected (bad JSON / undeclared name). */
  malformedToolCallCount: number;
  /** Total tool-call blocks the parser saw (malformed + capped + valid). */
  emittedToolCallCount: number;
  /** Assistant-visible text for the turn (excluding the tool-call blocks). */
  text: string;
}

export interface MissingToolCallDecision {
  retry: boolean;
  reason: MissingToolCallReason;
}

/**
 * Matches a model reply that talks about a tool as if it did not exist, which
 * is the signature of the "lost tool definitions under long context" failure.
 * Kept deliberately narrow to avoid retrying legitimate prose.
 */
export function isToolHesitationText(text: string): boolean {
  if (!text) return false;
  return /\btools?\b[^.\n]{0,24}?\b(?:does\s*n[o']?t|do\s*n[o']?t|does\s*not|do\s*not)\b[^.\n]{0,12}?\bexist/i.test(
    text,
  );
}

/**
 * Detects when the model dumped a raw tool-call JSON payload as prose instead
 * of emitting it as a structured tool call. The parser already strips proper
 * `<tool_call>...</tool_call>` blocks, so any JSON that still reaches the
 * visible `text` is a hallucinated tool-call-as-prose.
 *
 * Matches both shapes observed in the wild:
 *   {"name":"read","arguments":{...}}
 *   {"name":"read","arguments":{"i":"...","path":"..."}}
 *
 * Also catches a stray `</tool_call>` tag that leaked into prose (the parser
 * would have consumed the matching open tag, leaving the close orphaned).
 */
export function isRawToolCallJsonInText(text: string): boolean {
  if (!text) return false;
  const hasToolCallJson =
    /\{\s*"name"\s*:\s*"[a-zA-Z_][a-zA-Z0-9_]*"\s*,\s*"arguments"\s*:\s*\{/i.test(text);
  const hasStrayCloseTag = /<\/tool_call>/.test(text);
  return hasToolCallJson || hasStrayCloseTag;
}

export function decideMissingToolCallRetry(
  input: MissingToolCallInput,
): MissingToolCallDecision {
  const {
    declaredToolCount,
    successfulToolCallCount,
    malformedToolCallCount,
    emittedToolCallCount,
    text,
  } = input;

  // No tools were declared: a text answer is the expected outcome.
  if (declaredToolCount <= 0) return { retry: false, reason: null };

  // A usable call was produced: nothing to recover.
  if (successfulToolCallCount > 0) return { retry: false, reason: null };

  // Existing behaviour: a block was emitted but it was rejected.
  if (malformedToolCallCount > 0) return { retry: true, reason: "malformed" };

  // New behaviour: no `<tool_call>` block was emitted at all, yet the model
  // talked about tools as missing (the "does not exists" case).
  if (emittedToolCallCount === 0 && isToolHesitationText(text)) {
    return { retry: true, reason: "no_call" };
  }

  // New behaviour: model dumped a raw tool-call JSON as prose (visible in the
  // assistant text instead of being emitted as a structured tool call).
  // The parser strips proper `<tool_call>...</tool_call>` blocks, so any JSON
  // reaching the visible text is a hallucinated tool-call-as-prose.
  if (isRawToolCallJsonInText(text)) {
    return { retry: true, reason: "json_in_text" };
  }

  return { retry: false, reason: null };
}
