import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { invalidateAccountsCache } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import { getAccountProfilePath } from "../core/paths.ts";
import {
  importQwenSessionAccount,
  validateQwenStorageState,
} from "../core/session-import.ts";

function state(value: string) {
  return {
    cookies: [{ name: "token", value, domain: ".qwen.ai", path: "/", expires: -1 }],
    origins: [{ origin: "https://chat.qwen.ai", localStorage: [] }],
  };
}

test("validateQwenStorageState rejects missing authenticated cookies", () => {
  assert.throws(() => validateQwenStorageState(null), /storage state/i);
  assert.throws(() => validateQwenStorageState({ cookies: [] }), /authenticated/i);
  assert.throws(
    () => validateQwenStorageState({ cookies: [{ name: "token", value: "", domain: ".qwen.ai", path: "/" }] }),
    /authenticated/i,
  );
  assert.throws(
    () => validateQwenStorageState({
      cookies: [{ name: "token", value: "secret", domain: ".example.com", path: "/" }],
    }),
    /authenticated/i,
  );
  assert.throws(
    () => validateQwenStorageState({
      cookies: [{ name: "token", value: "secret", domain: ".qwen.ai", path: "" }],
    }),
    /cookie/i,
  );
  assert.throws(
    () => validateQwenStorageState({
      cookies: [{ name: "token", value: "secret", domain: ".qwen.ai", path: "/" }],
      origins: [{ origin: "not-a-url", localStorage: [] }],
    }),
    /origins/i,
  );
});

test("validateQwenStorageState materializes localStorage token and rejects refresh-only state", () => {
  const normalized = validateQwenStorageState({
    cookies: [{ name: "refresh_token", value: "refresh", domain: ".qwen.ai", path: "/" }],
    origins: [{ origin: "https://chat.qwen.ai", localStorage: [{ name: "token", value: "access" }] }],
  });
  assert.ok(normalized.cookies.some((cookie) => cookie.name === "token" && cookie.value === "access"));
  assert.throws(
    () => validateQwenStorageState({
      cookies: [{ name: "refresh_token", value: "refresh", domain: ".qwen.ai", path: "/" }],
      origins: [],
    }),
    /authenticated/i,
  );
});

test("importQwenSessionAccount installs a passwordless account and storage state", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const id = `otp-${suffix}`;
  const email = `otp-${suffix}@example.invalid`;
  const unrelatedId = `unrelated-${suffix}`;
  const unrelatedEmail = `unrelated-${suffix}@example.invalid`;
  const db = getDatabase();

  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(unrelatedId, unrelatedEmail, "keep-me");
  try {
    const imported = importQwenSessionAccount({ id, email, storageState: state("first") });
    assert.deepEqual(imported, { id, email });

    const row = db.prepare("SELECT id, email, password FROM accounts WHERE email = ?").get(email) as Record<string, string>;
    assert.deepEqual(row, { id, email, password: "" });
    assert.ok(db.prepare("SELECT id FROM accounts WHERE id = ?").get(unrelatedId));

    const saved = JSON.parse(fs.readFileSync(`${getAccountProfilePath(id)}/storage_state.json`, "utf8"));
    assert.deepEqual(saved, state("first"));
  } finally {
    db.prepare("DELETE FROM accounts WHERE id IN (?, ?)").run(id, unrelatedId);
    fs.rmSync(getAccountProfilePath(id), { recursive: true, force: true });
    invalidateAccountsCache();
  }
});

test("importQwenSessionAccount reuses existing account id and replaces its session", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const existingId = `existing-${suffix}`;
  const requestedId = `requested-${suffix}`;
  const email = `existing-${suffix}@example.invalid`;
  const db = getDatabase();

  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(existingId, email, "legacy-password");
  try {
    const imported = importQwenSessionAccount({ id: requestedId, email, storageState: state("updated") });
    assert.deepEqual(imported, { id: existingId, email });

    const row = db.prepare("SELECT password FROM accounts WHERE id = ?").get(existingId) as { password: string };
    assert.equal(row.password, "legacy-password");
    const saved = JSON.parse(fs.readFileSync(`${getAccountProfilePath(existingId)}/storage_state.json`, "utf8"));
    assert.deepEqual(saved, state("updated"));
    assert.equal(fs.existsSync(getAccountProfilePath(requestedId)), false);
  } finally {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(existingId);
    fs.rmSync(getAccountProfilePath(existingId), { recursive: true, force: true });
    fs.rmSync(getAccountProfilePath(requestedId), { recursive: true, force: true });
    invalidateAccountsCache();
  }
});
