#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { importQwenSessionAccount } from "./core/session-import.ts";

try {
  const accountFile = process.argv[2];
  if (!accountFile || !path.isAbsolute(accountFile)) throw new Error("Absolute account file path required");
  const account = JSON.parse(fs.readFileSync(accountFile, "utf8")) as Record<string, unknown>;
  if (account.flow !== "verification-code") throw new Error("Qwen account is not a verification-code session");
  importQwenSessionAccount({
    id: String(account.id ?? account.email ?? ""),
    email: String(account.email ?? ""),
    storageState: account.storageState,
  });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown session import error";
  console.error(`Qwen session import failed: ${message}`);
  process.exit(1);
}
