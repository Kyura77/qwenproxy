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

export type MissingToolCallReason = "malformed" | "no_call" | null;

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

  return { retry: false, reason: null };
}
