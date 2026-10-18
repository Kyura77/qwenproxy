/**
 * Process teardown error guard.
 *
 * Catches unhandled rejections and uncaught exceptions that arise from
 * benign browser/CDP connection closures (e.g. ProtocolError: session closed,
 * Network.setCacheDisabled, target crashed during shutdown) and prevents
 * them from terminating the Node.js process.
 */

export function isPlaywrightAlreadyClosedMessage(message: string): boolean {
  if (!message) return false;
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Target crashed") ||
    message.includes("Page crashed") ||
    message.includes("Assertion error") ||
    message.includes("Cannot find parent object") ||
    message.includes("Connection closed") ||
    message.includes("session closed") ||
    message.includes("Session closed") ||
    message.includes("Network.setCacheDisabled") ||
    message.includes("Protocol error") ||
    message.includes("storageState timed out")
  );
}

/**
 * Node/libuv I/O failures emitted by a dead browser/CDP pipe.
 *
 * When the Playwright browser process dies mid-write, the transport keeps
 * retrying the fd and surfaces raw `EIO`/`EPIPE` objects
 * (`{ errno: -5, code: "EIO", syscall: "write" }`) with no `message`
 * field. Those never match the string-based CDP list above, so they used to
 * fall through to the generic `console.error` branch — and because the pipe
 * keeps failing, the same exception re-fired forever, starving the event loop
 * and wedging the server (observed: `Rl` process, 100% CPU, CLOSE-WAIT
 * backlog). Treat them as driver I/O teardown noise.
 */
export function isBenignDriverIoError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : undefined;
  const errno = typeof e.errno === "number" ? e.errno : undefined;
  const syscall = typeof e.syscall === "string" ? e.syscall : undefined;
  const message = typeof e.message === "string" ? e.message : "";

  const ioLikeSyscall =
    syscall === undefined ||
    ["write", "read", "close", "shutdown", "connect", "sendmsg", "recvmsg"].includes(
      syscall,
    );
  const byCode =
    code === "EIO" || code === "EPIPE" || code === "ECONNRESET" || code === "ENOTCONN";
  const byErrno = errno === -5 || errno === -32 || errno === -104 || errno === -107;
  const byMessage = /\bEIO\b|\bEPIPE\b|\bECONNRESET\b|broken pipe|write EPIPE/i.test(
    message,
  );
  return ioLikeSyscall && (byCode || byErrno || byMessage);
}

export function isBenignTeardownError(error: unknown): boolean {
  if (!error) return false;
  if (isBenignDriverIoError(error)) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && "message" in error
        ? String((error as any).message)
        : String(error);
  return isPlaywrightAlreadyClosedMessage(message);
}

/** Rolling window used to detect a runaway benign-error storm. */
export const TEARDOWN_BURST_WINDOW_MS = 5_000;
/** Benign teardown errors within the window before the process is recycled. */
export const TEARDOWN_BURST_THRESHOLD = 30;

/**
 * Decides whether the benign-teardown error stream has turned into a runaway
 * loop. A dead browser pipe re-throws every few ms; swallowing that forever
 * spins the event loop and wedges the server, so past the burst threshold we
 * force the process to exit and let the supervisor restart a fresh browser.
 */
export function evaluateTeardownBurst(
  timestamps: readonly number[],
  now: number,
  windowMs: number = TEARDOWN_BURST_WINDOW_MS,
  threshold: number = TEARDOWN_BURST_THRESHOLD,
): { recent: number; shouldExit: boolean } {
  const recent = timestamps.filter((t) => now - t <= windowMs).length;
  return { recent, shouldExit: recent >= threshold };
}

let guardsInstalled = false;

/**
 * Installs process-wide handlers for uncaughtException and unhandledRejection
 * to guard against asynchronous Playwright/CDP driver teardown crashes.
 */
export function installProcessTeardownGuards(label = "Process"): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  const teardownErrorTimes: number[] = [];

  // Returns true when the benign error was absorbed. Recycles the process if
  // the benign stream has become a runaway loop (dead browser pipe).
  const absorbBenignTeardownError = (kind: string, msg: string): boolean => {
    const now = Date.now();
    teardownErrorTimes.push(now);
    while (
      teardownErrorTimes.length > 0 &&
      now - teardownErrorTimes[0] > TEARDOWN_BURST_WINDOW_MS
    ) {
      teardownErrorTimes.shift();
    }
    const { recent, shouldExit } = evaluateTeardownBurst(teardownErrorTimes, now);
    if (shouldExit) {
      console.warn(
        `💥 [${label}] ${recent} driver teardown errors in ${TEARDOWN_BURST_WINDOW_MS / 1000}s ` +
          `(${kind}: ${msg}). Browser pipe is dead — exiting so the supervisor restarts a fresh process.`,
      );
      // Give the log a tick to flush before tearing the loop down.
      setTimeout(() => process.exit(1), 0).unref?.();
      return true;
    }
    console.warn(`⚠️  [${label}] Handled benign driver teardown ${kind}: ${msg}`);
    return true;
  };

  process.on("uncaughtException", (error: unknown) => {
    if (isBenignTeardownError(error)) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as any).message)
            : String(error);
      absorbBenignTeardownError("exception", msg || String(error));
      return;
    }
    console.error(`❌ [${label}] Uncaught Exception:`, error);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    if (isBenignTeardownError(reason)) {
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === "object" && reason !== null && "message" in reason
            ? String((reason as any).message)
            : String(reason);
      absorbBenignTeardownError("rejection", msg || String(reason));
      return;
    }
    console.error(`❌ [${label}] Unhandled Rejection:`, reason);
  });
}
