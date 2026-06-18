import { randomBytes } from "node:crypto";

export function id(prefix) {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

export function now() {
  return new Date().toISOString();
}

export function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
