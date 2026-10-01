import fs from "node:fs";
import path from "node:path";

import { invalidateAccountsCache } from "./accounts.ts";
import { getDatabase } from "./database.ts";
import { getAccountProfilePath } from "./paths.ts";

export interface QwenStorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

export interface QwenSessionAccountInput {
  id: string;
  email: string;
  storageState: unknown;
}

export function validateQwenStorageState(value: unknown): QwenStorageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Qwen storage state");
  }
  const candidate = value as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(candidate.cookies)) throw new Error("Invalid Qwen storage state cookies");
  const cookiesAreValid = candidate.cookies.every((cookie) => {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) return false;
    const item = cookie as { name?: unknown; value?: unknown; domain?: unknown; path?: unknown };
    return typeof item.name === "string" && item.name.length > 0 &&
      typeof item.value === "string" && typeof item.domain === "string" && item.domain.length > 0 &&
      typeof item.path === "string" && item.path.startsWith("/");
  });
  if (!cookiesAreValid) throw new Error("Invalid Qwen storage state cookie");
  const hasAuthCookie = candidate.cookies.some((cookie) => {
    const item = cookie as { name: string; value: string; domain: string };
    return item.name === "token" && item.value.length > 0 &&
      /(^|\.)qwen\.(ai|com)$/i.test(item.domain);
  });
  const originsAreValid = candidate.origins === undefined ||
    (Array.isArray(candidate.origins) && candidate.origins.every((origin) => {
      if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
      const item = origin as { origin?: unknown; localStorage?: unknown };
      if (typeof item.origin !== "string" || !Array.isArray(item.localStorage)) return false;
      try { new URL(item.origin); return true; } catch { return false; }
    }));
  if (!originsAreValid) {
    throw new Error("Invalid Qwen storage state origins");
  }
  const origins = (candidate.origins ?? []) as Array<Record<string, unknown>>;
  const localToken = origins
    .filter((origin) => {
      try {
        const hostname = new URL(String(origin.origin)).hostname;
        return /(^|\.)qwen\.(ai|com)$/i.test(hostname);
      } catch { return false; }
    })
    .flatMap((origin) => origin.localStorage as Array<Record<string, unknown>>)
    .find((entry) => entry.name === "token" && typeof entry.value === "string" && entry.value.length > 0)
    ?.value as string | undefined;
  if (!hasAuthCookie && !localToken) throw new Error("Qwen storage state has no authenticated access token");

  const cookies = candidate.cookies as Array<Record<string, unknown>>;
  return {
    cookies: hasAuthCookie ? cookies : [
      ...cookies,
      {
        name: "token",
        value: localToken,
        domain: ".qwen.ai",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins,
  };
}

function validateAccountId(id: string): void {
  if (!/^[A-Za-z0-9@._+-]+$/.test(id) || id.includes("..")) {
    throw new Error("Invalid Qwen account id");
  }
}

export function importQwenSessionAccount(input: QwenSessionAccountInput): { id: string; email: string } {
  const requestedId = String(input.id ?? "").trim();
  const email = String(input.email ?? "").trim();
  if (!email.includes("@")) throw new Error("Invalid Qwen account email");
  validateAccountId(requestedId);
  const storageState = validateQwenStorageState(input.storageState);

  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email) as { id: string } | undefined;
  const id = existing?.id ?? requestedId;
  validateAccountId(id);

  const profileDir = getAccountProfilePath(id);
  fs.mkdirSync(profileDir, { recursive: true });
  const destination = path.join(profileDir, "storage_state.json");
  const temporary = path.join(profileDir, `.storage_state.${process.pid}.${Date.now()}.tmp`);
  const backup = path.join(profileDir, `.storage_state.${process.pid}.${Date.now()}.bak`);
  fs.writeFileSync(temporary, JSON.stringify(storageState), { mode: 0o600 });

  try {
    if (fs.existsSync(destination)) fs.copyFileSync(destination, backup);
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
    }
    try { fs.chmodSync(destination, 0o600); } catch { /* Windows */ }
    if (!existing) {
      db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, '')").run(id, email);
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    } else if (!existing) {
      fs.rmSync(destination, { force: true });
    }
    throw error;
  }

  try { fs.rmSync(backup, { force: true }); } catch { /* stale backup is harmless */ }

  invalidateAccountsCache();
  return { id, email };
}
