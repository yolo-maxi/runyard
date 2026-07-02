import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

export function randomToken() {
  return `shub_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function sign(value) {
  const sig = createHmac("sha256", env.sessionSecret).update(value).digest("base64url");
  return `${value}.${sig}`;
}

export function unsign(signed) {
  const raw = String(signed || "");
  const index = raw.lastIndexOf(".");
  if (index < 1) return null;
  const value = raw.slice(0, index);
  const sig = raw.slice(index + 1);
  const expected = createHmac("sha256", env.sessionSecret).update(value).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return value;
}

// Constant-time string comparison that never throws on length mismatch.
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ab.length !== bb.length) {
    // Compare against self to keep timing roughly constant, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function parseCookies(req) {
  const header = String(req?.headers?.cookie || "");
  const cookies = {};
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = safeDecodeCookiePart(part.slice(0, index));
    const value = safeDecodeCookiePart(part.slice(index + 1));
    if (!name || value == null) continue;
    cookies[name] = value;
  }
  return cookies;
}

function safeDecodeCookiePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
