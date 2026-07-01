import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readTokenFile(file) {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trim();
}

export function writePrivateTokenFile(file, token) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

export function readOrCreateTokenFile(file, { createToken, onCreate = null } = {}) {
  const existing = readTokenFile(file);
  if (existing) return existing;
  const token = createToken();
  writePrivateTokenFile(file, token);
  if (onCreate) onCreate(file, token);
  return token;
}
