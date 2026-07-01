export const COMMON_SECRET_REDACTION_RULES = [
  { re: /\b[Bb]earer\s+[A-Za-z0-9._-]{8,}\b/g, replace: "Bearer [redacted]" },
  { re: /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(x-api-key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(api[_-]?key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(access[_-]?token\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(refresh[_-]?token\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(password\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(passwd\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(secret\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(token\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /\bshub_[A-Za-z0-9_=-]+\b/g, replace: "shub_[redacted]" },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: "sk-[redacted]" },
  { re: /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, replace: "gh_[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+\b/g, replace: "[redacted-jwt]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[redacted-private-key]" }
];

export function applyRedactionRules(value, rules = COMMON_SECRET_REDACTION_RULES) {
  let text = String(value ?? "");
  for (const { re, replace } of rules) text = text.replace(re, replace);
  return text;
}

export function truncateText(value, max, { collapseWhitespace = false, wordBoundary = false } = {}) {
  const text = collapseWhitespace
    ? String(value ?? "").replace(/\s+/g, " ").trim()
    : String(value || "").trim();
  if (!max || text.length <= max) return text;
  const sliced = text.slice(0, Math.max(0, max - 1));
  const prefix = wordBoundary ? sliced.replace(/\s+\S*$/, "") : sliced.trimEnd();
  return `${prefix}…`;
}

export function redactText(value, options = {}) {
  const {
    max = 240,
    rules = COMMON_SECRET_REDACTION_RULES,
    collapseWhitespace = false,
    wordBoundary = false
  } = options;
  return truncateText(applyRedactionRules(value, rules), max, { collapseWhitespace, wordBoundary });
}
