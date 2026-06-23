// Encrypted reusable-secrets store.
//
// Crypto-only module: it knows how to turn a plaintext secret value into an
// at-rest ciphertext blob and back, and how to scrub secret values out of any
// run output/artifact/log before it is persisted. It deliberately holds NO
// database or HTTP concerns so it is trivially unit-testable and so the
// encryption key never leaves this file's closure.
//
// At-rest format (AES-256-GCM):  [12-byte IV][16-byte auth tag][ciphertext]
// stored as a single Buffer (SQLite BLOB). The IV is random per write, so two
// encryptions of the same plaintext produce different blobs.
//
// Security invariants:
//   - Never log the key or any plaintext (this module never calls console.*).
//   - If SECRETS_ENC_KEY is unset/invalid the feature is DISABLED: encrypt()
//     and decrypt() throw, the caller (db/server) maps that to a clear 503,
//     and we never fall back to storing plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

// Parse SECRETS_ENC_KEY into a 32-byte Buffer. Accepts base64, base64url, or
// hex. Returns null when unset or not exactly 32 bytes (so the feature stays
// disabled rather than running with a weak/truncated key). Never throws and
// never logs the key material.
export function loadSecretsKey(raw = process.env.SECRETS_ENC_KEY) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const candidates = [];
  if (/^[0-9a-fA-F]+$/.test(value) && value.length === KEY_LEN * 2) {
    candidates.push(Buffer.from(value, "hex"));
  }
  // base64 / base64url — Buffer is lenient, so we length-check the decode.
  try {
    candidates.push(Buffer.from(value, "base64"));
  } catch {
    /* ignore */
  }
  for (const buf of candidates) {
    if (buf && buf.length === KEY_LEN) return buf;
  }
  return null;
}

// Whether the encrypted-secrets feature is usable in this process. The server
// uses this to return 503 on the secrets API and to skip injection when no key
// is configured.
export function secretsEnabled(raw = process.env.SECRETS_ENC_KEY) {
  return loadSecretsKey(raw) !== null;
}

function requireKey(raw) {
  const key = loadSecretsKey(raw);
  if (!key) {
    throw new Error("secrets store disabled: SECRETS_ENC_KEY is not set to a valid 32-byte key");
  }
  return key;
}

// Encrypt a plaintext string -> Buffer blob suitable for a SQLite BLOB column.
export function encrypt(plaintext, raw = process.env.SECRETS_ENC_KEY) {
  const key = requireKey(raw);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

// Decrypt a blob produced by encrypt() back to the plaintext string. Throws if
// the key is wrong/missing or the ciphertext was tampered with (GCM auth).
export function decrypt(blob, raw = process.env.SECRETS_ENC_KEY) {
  const key = requireKey(raw);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("secrets store: ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const REDACTION = "[redacted:secret]";

// Pure redaction over an arbitrary JSON-ish value. Every occurrence of any
// secret value (string) is replaced with REDACTION, recursively through
// objects/arrays and inside strings. This is the last line of defense before
// any run output/artifact/event is persisted or returned: even if a workflow
// echoes an injected secret, the stored copy is scrubbed.
//
// `secretValues` is an array of plaintext strings. Short/empty values are
// skipped so we don't redact incidental characters.
export function redactSecrets(value, secretValues = []) {
  const needles = [...new Set((secretValues || []).map((v) => String(v ?? "")).filter((v) => v.length >= 4))];
  if (!needles.length) return value;
  // Replace longest-first so a secret that contains another secret as a
  // substring still fully redacts.
  needles.sort((a, b) => b.length - a.length);
  return walk(value, needles);
}

function scrubString(str, needles) {
  let out = str;
  for (const needle of needles) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTION);
  }
  return out;
}

function walk(value, needles) {
  if (typeof value === "string") return scrubString(value, needles);
  if (Array.isArray(value)) return value.map((item) => walk(item, needles));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, needles);
    return out;
  }
  return value;
}

export const __test__ = { REDACTION, IV_LEN, TAG_LEN, KEY_LEN };
