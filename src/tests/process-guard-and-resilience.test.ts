import test from "node:test";
import assert from "node:assert/strict";
import {
  isBenignTeardownError,
  isPlaywrightAlreadyClosedMessage,
  isBenignDriverIoError,
  evaluateTeardownBurst,
  TEARDOWN_BURST_WINDOW_MS,
  TEARDOWN_BURST_THRESHOLD,
} from "../core/process-guard.ts";
import { config } from "../core/config.ts";
import {
  isInternalServerError,
  classifyRetryAction,
  throwFromSseUpstreamError,
} from "../routes/chat/retry-policy.ts";
import { RetryableQwenStreamError } from "../services/qwen-errors.ts";

test("process-guard: correctly identifies benign Playwright CDP closure errors", () => {
  const cdpError = new Error(
    "Protocol error (Network.setCacheDisabled): Internal server error, session closed.",
  );
  assert.equal(isBenignTeardownError(cdpError), true);
  assert.equal(
    isPlaywrightAlreadyClosedMessage(
      "Protocol error (Network.setCacheDisabled): Internal server error, session closed.",
    ),
    true,
  );

  const storageTimeout = new Error("storageState timed out after 5000ms");
  assert.equal(isBenignTeardownError(storageTimeout), true);

  const targetClosed = new Error("Target page, context or browser has been closed");
  assert.equal(isBenignTeardownError(targetClosed), true);

  const realAppError = new Error("TypeError: Cannot read property of undefined");
  assert.equal(isBenignTeardownError(realAppError), false);
});

test("process-guard: treats a dead-browser EIO/EPIPE write as benign driver I/O", () => {
  const eio = { errno: -5, code: "EIO", syscall: "write" };
  const epipe = { errno: -32, code: "EPIPE", syscall: "write" };
  const econnreset = { errno: -104, code: "ECONNRESET", syscall: "read" };
  const byMessage = new Error("write EPIPE: broken pipe");

  assert.equal(isBenignDriverIoError(eio), true);
  assert.equal(isBenignDriverIoError(epipe), true);
  assert.equal(isBenignDriverIoError(econnreset), true);
  assert.equal(isBenignDriverIoError(byMessage), true);

  // These are the exact objects the runaway Playwright loop emitted.
  assert.equal(isBenignTeardownError(eio), true);
  assert.equal(isBenignTeardownError({ errno: -5, code: "EIO", syscall: "write" }), true);

  // Real application failures and unrelated error codes must NOT be swallowed.
  assert.equal(isBenignDriverIoError({ code: "ENOENT", syscall: "open" }), false);
  assert.equal(isBenignDriverIoError(new Error("TypeError: x is not a function")), false);
  assert.equal(isBenignDriverIoError(null), false);
  assert.equal(isBenignTeardownError({ code: "ENOENT", syscall: "open" }), false);
});

test("process-guard: recycles the process only after a runaway teardown burst", () => {
  const now = 1_000_000;

  // A healthy single event is absorbed, not fatal.
  assert.deepEqual(evaluateTeardownBurst([now - 10], now), {
    recent: 1,
    shouldExit: false,
  });

  // Just under threshold within the window: still absorb.
  const under = Array.from({ length: TEARDOWN_BURST_THRESHOLD - 1 }, (_, i) => now - i);
  assert.equal(evaluateTeardownBurst(under, now).shouldExit, false);

  // At/over threshold within the window: the loop is runaway → exit.
  const over = Array.from({ length: TEARDOWN_BURST_THRESHOLD }, (_, i) => now - i);
  const decision = evaluateTeardownBurst(over, now);
  assert.equal(decision.recent, TEARDOWN_BURST_THRESHOLD);
  assert.equal(decision.shouldExit, true);

  // Old timestamps outside the window are pruned, so a slow trickle never trips.
  const stale = Array.from(
    { length: TEARDOWN_BURST_THRESHOLD * 2 },
    (_, i) => now - TEARDOWN_BURST_WINDOW_MS - (i + 1),
  );
  assert.equal(evaluateTeardownBurst(stale, now).shouldExit, false);
});

test("config: reasoning model timeout defaults to 300,000ms (5 minutes)", () => {
  assert.equal(config.timeouts.reasoningModelTimeout, 300_000);
});

test("retry-policy: isInternalServerError detects Qwen upstream internal errors", () => {
  const err1 = { code: "internal_error", message: "Ocorreu um erro inesperado." };
  assert.equal(isInternalServerError(err1), true);

  const err2 = new Error(
    "internal_error: Ocorreu um erro inesperado. Tente novamente mais tarde.",
  );
  assert.equal(isInternalServerError(err2), true);

  const err3 = { code: "server_busy", message: "Server busy, please retry." };
  assert.equal(isInternalServerError(err3), true);

  const normalErr = new Error("Invalid request schema");
  assert.equal(isInternalServerError(normalErr), false);
});

test("retry-policy: classifyRetryAction categorizes internal_error as upstream_internal_error", () => {
  const err = Object.assign(
    new Error("internal_error: Ocorreu um erro inesperado."),
    { upstreamCode: "internal_error" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "upstream_internal_error");
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
});

test("retry-policy: throwFromSseUpstreamError maps internal_error to RetryableQwenStreamError with switchAccount and forceNewChat", () => {
  assert.throws(
    () =>
      throwFromSseUpstreamError(
        "internal_error",
        "Ocorreu um erro inesperado. Tente novamente mais tarde.",
      ),
    (err: unknown) => {
      assert.ok(err instanceof RetryableQwenStreamError);
      const typed = err as RetryableQwenStreamError & {
        switchAccount?: boolean;
        forceNewChat?: boolean;
        upstreamCode?: string;
      };
      assert.equal(typed.upstreamCode, "internal_error");
      assert.equal(typed.switchAccount, true);
      assert.equal(typed.forceNewChat, true);
      return true;
    },
  );
});
