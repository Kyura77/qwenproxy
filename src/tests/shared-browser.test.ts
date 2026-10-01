import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getStorageStatePath,
  loadStorageState,
  saveStorageState,
  isPlaywrightAlreadyClosedError,
  isPageLoggedIn,
  cleanupOrphanProfiles,
  shouldRestoreStorageStateCookies,
  pickRefreshToken,
} from "../services/playwright.ts";
test("Playwright Storage State: getStorageStatePath returns storage_state.json inside profile path", () => {
  const accountId = "test-acc-123";
  const statePath = getStorageStatePath(accountId);
  assert.ok(statePath.endsWith("storage_state.json"));
  assert.ok(statePath.includes(accountId));
});

test("Playwright Storage State: loadStorageState returns undefined when file does not exist", () => {
  const nonExistent = loadStorageState("non-existent-account-999");
  assert.equal(nonExistent, undefined);
});

test("Playwright Storage State: loadStorageState validates JSON and cookies array", () => {
  const accountId = "storage-test-acc";
  const statePath = getStorageStatePath(accountId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    // 1. Invalid structure
    fs.writeFileSync(statePath, JSON.stringify({ invalid: true }));
    assert.equal(loadStorageState(accountId), undefined);

    // 2. Valid structure with cookies
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: "token", value: "abc" }], origins: [] }));
    const loaded = loadStorageState(accountId);
    assert.ok(loaded);
    assert.equal(loaded, statePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("Playwright Storage State: saveStorageState bounds hung storageState call with timeout", async () => {
  const accountId = "hang-test-acc";
  let timer: NodeJS.Timeout | undefined;
  const fakeContext: any = {
    storageState: () =>
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ cookies: [], origins: [] }), 250);
      }),
  };
  try {
    const start = Date.now();
    await saveStorageState(fakeContext, accountId, 100);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 80 && elapsed < 3000, `must time out within bounds, took ${elapsed}ms`);
  } finally {
    if (timer) clearTimeout(timer);
  }
});

test("Playwright Storage State: restores saved auth cookie into a non-empty guest profile", () => {
  const guestCookies = [{ name: "qwen-locale", value: "en-US" }, { name: "refresh_token", value: "refresh" }];
  const savedCookies = [{ name: "token", value: "access" }, { name: "refresh_token", value: "refresh" }];

  assert.equal(shouldRestoreStorageStateCookies(guestCookies, savedCookies), true);
  assert.equal(shouldRestoreStorageStateCookies([{ name: "token", value: "current" }], savedCookies), false);
  assert.equal(shouldRestoreStorageStateCookies(guestCookies, [{ name: "locale", value: "en-US" }]), false);
});

test("Playwright refresh token: prefers session, then localStorage, then cookie (OTP fallback)", () => {
  assert.equal(pickRefreshToken("session", "local", "cookie"), "session");
  assert.equal(pickRefreshToken(undefined, "local", "cookie"), "local");
  assert.equal(pickRefreshToken(undefined, undefined, "cookie"), "cookie");
  assert.equal(pickRefreshToken(undefined, "", undefined), undefined);
});

test("Playwright already-closed error detection", () => {
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Some random network failure")), false);
  assert.equal(isPlaywrightAlreadyClosedError({ type: "closed", message: "Protocol error (Network.setCacheDisabled): Internal server error, session closed." }), true);
});

test("isPageLoggedIn detects authenticated session via API/DOM and rejects unauthenticated", async () => {
  const authUrlPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/auth?redirect=/",
  };
  assert.equal(await isPageLoggedIn(authUrlPage), false);

  const loginUrlPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/login",
  };
  assert.equal(await isPageLoggedIn(loginUrlPage), false);

  const loggedOutApiPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => false,
  };
  assert.equal(await isPageLoggedIn(loggedOutApiPage), false);

  const loggedInApiPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => true,
  };
  assert.equal(await isPageLoggedIn(loggedInApiPage), true);

  const closedPage: any = {
    isClosed: () => true,
    url: () => "https://chat.qwen.ai/",
  };
  assert.equal(await isPageLoggedIn(closedPage), false);
});
test("isPageLoggedIn bounds a hanging in-page probe instead of waiting forever", async () => {
  let timer: NodeJS.Timeout | undefined;
  const hangingPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: () =>
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 250);
      }),
  };

  try {
    const startedAt = Date.now();
    assert.equal(await isPageLoggedIn(hangingPage, 100), false);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 80 && elapsed < 3000, `probe must fail at its bound, took ${elapsed}ms`);
  } finally {
    if (timer) clearTimeout(timer);
  }
});
test("cleanupOrphanProfiles removes directories not belonging to active accounts and stale dirs", () => {
  const tempBase = path.join(process.cwd(), ".tmp", "test-profiles-" + Date.now());
  fs.mkdirSync(tempBase, { recursive: true });

  try {
    // 1. Create active account folder
    const activeDir = path.join(tempBase, "active-acc-1");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "storage_state.json"), "{}");

    // 2. Create orphan folder (not in accounts)
    const orphanDir = path.join(tempBase, "orphan-acc-99");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "junk.txt"), "hello orphan");

    // 3. Create stale folder
    const staleDir = path.join(tempBase, "active-acc-1.stale-12345");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "old.txt"), "old data");

    const activeSet = new Set(["active-acc-1"]);
    const result = cleanupOrphanProfiles(tempBase, activeSet);
    // Active folder should still exist
    assert.equal(fs.existsSync(activeDir), true, "active account folder must be preserved");
    // Orphan and stale folders should be removed
    assert.equal(fs.existsSync(orphanDir), false, "orphan folder must be deleted");
    assert.equal(fs.existsSync(staleDir), false, "stale folder must be deleted");
    assert.equal(result.removedCount, 2, "must report 2 removed directories");
    assert.ok(result.freedBytes > 0, "must report freed bytes > 0");
  } finally {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
  }
});
