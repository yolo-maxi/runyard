import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const configDir = path.join(os.homedir(), ".runyard");
export const configFile = path.join(configDir, "config.json");

const EMPTY = { version: 2, current: "default", remotes: {} };

// Read config, migrating the old single-remote shape ({url, token}) to the multi-remote shape.
export function readConfig() {
  if (!existsSync(configFile)) return { ...EMPTY, remotes: {} };
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return { ...EMPTY, remotes: {} };
  }
  if (raw && raw.remotes && typeof raw.remotes === "object") {
    return { version: 2, current: raw.current || Object.keys(raw.remotes)[0] || "default", remotes: raw.remotes };
  }
  if (raw && (raw.url || raw.token)) {
    return { version: 2, current: "default", remotes: { default: { url: raw.url, token: raw.token } } };
  }
  return { ...EMPTY, remotes: {} };
}

export function writeConfig(config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function setRemote(name, url, token) {
  const config = readConfig();
  config.remotes[name] = { url: String(url).replace(/\/$/, ""), token };
  config.current = name;
  writeConfig(config);
  return config;
}

// Resolve a remote to {name, url, token}. Honors an explicit name, else the current remote.
export function resolveRemote(name) {
  const config = readConfig();
  const target = name || config.current || "default";
  const remote = config.remotes[target] || {};
  return { name: target, url: remote.url || null, token: remote.token || null };
}
