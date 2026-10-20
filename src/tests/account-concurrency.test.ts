import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  acquireAccountLease,
  tryAcquireAccountLease,
  isAccountBusy,
  isAccountSlotHeldByOtherSession,
  isAccountTemporarilyBusy,
  markAccountTemporarilyBusy,
  clearTemporaryBusy,
  getAccountConcurrencySnapshot,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";

// Streams are unlimited per account - no capacity limit

test("AccountConcurrency: first lease is acquired immediately", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-1");
  assert.strictEqual(lease.accountId, "acc-1");
  lease.release();
});

test("AccountConcurrency: multiple leases acquired immediately (unlimited streams)", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-1");
  const lease2 = await acquireAccountLease("acc-1");
  const lease3 = await acquireAccountLease("acc-1");
  
  // All leases should be acquired immediately
  assert.ok(lease1 && lease2 && lease3);
  // The account IS serving (busy) — unlimited streams means no queue, not "idle"
  assert.strictEqual(isAccountBusy("acc-1"), true);

  lease1.release();
  lease2.release();
  lease3.release();
});

test("AccountConcurrency: slot held by another session is detected", async () => {
  resetAccountConcurrencyForTests();
  const leaseA = await acquireAccountLease("acc-cross-session", {
    label: "sess-A",
  });

  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-cross-session", "sess-B"),
    true,
    "slot held by sess-A must be reported as held-by-other for sess-B",
  );
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-cross-session", "sess-A"),
    false,
    "slot held by sess-A is NOT other-session for sess-A itself",
  );
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-cross-session", ""),
    false,
    "empty label never counts as held by other",
  );

  leaseA.release();
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-cross-session", "sess-B"),
    false,
    "free slot is not held by another session",
  );
});

test("AccountConcurrency: unknown account is not held by other", async () => {
  resetAccountConcurrencyForTests();
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-nonexistent", "sess-X"),
    false,
  );

  // With unlimited streams, active leases don't block other sessions
  const lease = await acquireAccountLease("acc-partial");
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-partial", "sess-Y"),
    true,
    "active lease counts as held by another session (label comparison)",
  );
  lease.release();
  assert.strictEqual(
    isAccountSlotHeldByOtherSession("acc-partial", "sess-Y"),
    false,
    "released slot is not held",
  );
});

test("AccountConcurrency: FIFO ordering for waiters", async () => {
  resetAccountConcurrencyForTests();
  const order: number[] = [];

  const lease1 = await acquireAccountLease("acc-fifo");

  const p1 = acquireAccountLease("acc-fifo", { timeoutMs: 5000 }).then((l) => {
    order.push(1);
    return l;
  });
  const p2 = acquireAccountLease("acc-fifo", { timeoutMs: 5000 }).then((l) => {
    order.push(2);
    return l;
  });

  await new Promise((r) => setTimeout(r, 10));
  lease1.release();

  const l1 = await p1;
  l1.release();

  const l2 = await p2;
  l2.release();

  assert.deepStrictEqual(order, [1, 2]);
});

test("AccountConcurrency: timeout removes waiter and rejects", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-timeout");

  // With unlimited streams, leases are granted immediately - no timeout
  const lease2 = await acquireAccountLease("acc-timeout", { timeoutMs: 50 });
  assert.ok(lease2);

  // Original leases still valid
  assert.strictEqual(isAccountBusy("acc-timeout"), true);
  lease1.release();
  lease2.release();
  assert.strictEqual(isAccountBusy("acc-timeout"), false);
});

test("AccountConcurrency: null timeoutMs grants immediately (unlimited streams)", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-null-timeout");

  // With unlimited streams, the second lease is granted immediately
  const lease2 = await acquireAccountLease("acc-null-timeout", {
    timeoutMs: null,
  });
  assert.ok(lease2);

  lease1.release();
  lease2.release();
});

test("AccountConcurrency: abort signal removes waiter and rejects", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-abort");
  const controller = new AbortController();

  // With unlimited streams, leases are granted immediately - no abort needed
  const lease2 = await acquireAccountLease("acc-abort", {
    timeoutMs: 10000,
    signal: controller.signal,
  });
  assert.ok(lease2);

  lease1.release();
  lease2.release();
});

test("AccountConcurrency: already-aborted signal rejects immediately", async () => {
  resetAccountConcurrencyForTests();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => acquireAccountLease("acc-pre-abort", { signal: controller.signal }),
    /Aborted before acquiring/,
  );
});

test("AccountConcurrency: duplicate release is safe", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-dup");
  lease.release();
  lease.release(); // should not throw or double-release
  assert.strictEqual(isAccountBusy("acc-dup"), false);
});

test("AccountConcurrency: different accounts do not block each other", async () => {
  resetAccountConcurrencyForTests();
  const leaseA = await acquireAccountLease("acc-a");
  const leaseB = await acquireAccountLease("acc-b");

  // Each account tracks its own leases — one account being busy never blocks the other
  assert.strictEqual(isAccountBusy("acc-a"), true);
  assert.strictEqual(isAccountBusy("acc-b"), true);

  leaseA.release();
  assert.strictEqual(isAccountBusy("acc-a"), false);
  assert.strictEqual(isAccountBusy("acc-b"), true);

  leaseB.release();
});

test("AccountConcurrency: tryAcquire always succeeds (unlimited streams)", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-try");
  const second = tryAcquireAccountLease("acc-try");
  assert.ok(second); // With unlimited streams, tryAcquire always succeeds
  lease.release();
  second!.release();

  const third = tryAcquireAccountLease("acc-try");
  assert.ok(third);
  third!.release();
});

test("AccountConcurrency: snapshot reports active counts", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-snap");

  // With unlimited streams, no waiters queue up
  const lease2 = await acquireAccountLease("acc-snap", { timeoutMs: 5000 });

  const snapshot = getAccountConcurrencySnapshot();
  const entry = snapshot.find((s) => s.accountId === "acc-snap");
  assert.ok(entry);
  assert.strictEqual(entry!.active, 2);
  assert.strictEqual(entry!.waiting, 0);
  assert.strictEqual(entry!.limit, Infinity);

  lease.release();
  lease2.release();
});

test("AccountConcurrency: temporary busy flag expires", async () => {
  resetAccountConcurrencyForTests();
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), false);

  markAccountTemporarilyBusy("acc-temp", 50);
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), true);

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), false);
});

test("AccountConcurrency: clearTemporaryBusy removes flag immediately", () => {
  resetAccountConcurrencyForTests();
  markAccountTemporarilyBusy("acc-clear", 60000);
  assert.strictEqual(isAccountTemporarilyBusy("acc-clear"), true);
  clearTemporaryBusy("acc-clear");
  assert.strictEqual(isAccountTemporarilyBusy("acc-clear"), false);
});

test("AccountConcurrency: no pending handles after reset", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-handles");
  const waiter = acquireAccountLease("acc-handles", { timeoutMs: 100000 }).catch(
    () => {},
  );
  await new Promise((r) => setTimeout(r, 10));

  resetAccountConcurrencyForTests();
  lease.release(); // safe even after reset
  await waiter;
});
