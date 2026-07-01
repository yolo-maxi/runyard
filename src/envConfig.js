import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const DEV_SESSION_SECRET = "dev-runyard-session-secret";

export function firstEnv(source, ...names) {
  const env = source || {};
  for (const name of names) {
    const value = env[name];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

export function defaultDbPath(dir, { exists = existsSync, stat = statSync } = {}) {
  const runyardDb = path.join(dir, "runyard.sqlite");
  const legacyDb = path.join(dir, "smithers-hub.sqlite");
  const runyardExists = exists(runyardDb);
  const legacyExists = exists(legacyDb);
  if (runyardExists && legacyExists) {
    try {
      return stat(legacyDb).size > stat(runyardDb).size ? legacyDb : runyardDb;
    } catch {
      return runyardDb;
    }
  }
  if (legacyExists) return legacyDb;
  return runyardDb;
}

export function deriveEnvironmentLabel({ env = process.env, baseUrl, isProduction } = {}) {
  const explicit = firstEnv(env, "RUNYARD_HUB_ENVIRONMENT", "SMITHERS_HUB_ENVIRONMENT", "RUNYARD_HUB_ENV", "SMITHERS_HUB_ENV") || "";
  if (explicit) return explicit.toLowerCase();
  if (!isProduction) return "local";
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (/(^|[.-])(stage|staging|preprod)([.-]|$)/.test(host)) return "staging";
    if (/(^|[.-])(dev|test)([.-]|$)/.test(host)) return "dev";
    return "prod";
  } catch {
    return "prod";
  }
}

export function deriveHostnameLabel({ env = process.env, baseUrl, hostname = os.hostname } = {}) {
  const explicit = firstEnv(env, "RUNYARD_HUB_HOSTNAME", "SMITHERS_HUB_HOSTNAME") || "";
  if (explicit) return explicit;
  try {
    const host = new URL(baseUrl).hostname;
    if (host && host !== "127.0.0.1" && host !== "localhost") return host;
  } catch {
    /* fall through */
  }
  try {
    return hostname() || "local";
  } catch {
    return "local";
  }
}

export function resolveSessionSecret({
  env = process.env,
  dataDir,
  isProduction,
  exists = existsSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
  chmod = chmodSync,
  random = () => randomBytes(32).toString("base64url")
} = {}) {
  const provided = firstEnv(env, "RUNYARD_HUB_SESSION_SECRET", "SMITHERS_HUB_SESSION_SECRET");
  if (provided && provided !== DEV_SESSION_SECRET) return provided;
  if (isProduction && provided === DEV_SESSION_SECRET) {
    throw new Error(
      "Refusing to start: RUNYARD_HUB_SESSION_SECRET is set to the insecure development default in a production deployment. Set a long random secret."
    );
  }

  const secretFile = path.join(dataDir, "session-secret.txt");
  if (exists(secretFile)) {
    const persisted = readFile(secretFile, "utf8").trim();
    if (persisted) return persisted;
  }

  const generated = random();
  writeFile(secretFile, `${generated}\n`, { mode: 0o600 });
  try {
    chmod(secretFile, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return generated;
}
