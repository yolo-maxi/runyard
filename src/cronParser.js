export const CRON_ALIASES = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *"
};

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS = [
  { key: "minute", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "dom", min: 1, max: 31 },
  { key: "month", min: 1, max: 12, names: MONTH_NAMES },
  { key: "dow", min: 0, max: 7, names: DOW_NAMES }
];

export function normalizeCronExpression(expression) {
  const raw = String(expression || "").trim();
  if (!raw) throw new Error("cron expression is empty");
  const normalized = raw.startsWith("@") ? CRON_ALIASES[raw.toLowerCase()] : raw;
  if (!normalized) throw new Error(`unknown cron alias "${raw}"`);
  return { raw, normalized };
}

function fieldNumber(token, field) {
  const named = field.names ? field.names[token.toLowerCase()] : undefined;
  const raw = named != null ? named : Number(token);
  if (!Number.isInteger(raw)) {
    throw new Error(`invalid value "${token}" in ${field.key} field`);
  }
  if (field.key === "dow" && raw === 7) return 0;
  if (raw < field.min || raw > field.max) {
    throw new Error(`value ${token} out of range (${field.min}-${field.max}) in ${field.key} field`);
  }
  return raw;
}

function addRange(set, from, to, step, field) {
  if (step <= 0) throw new Error(`invalid step in ${field.key} field`);
  if (from > to) throw new Error(`range start after end in ${field.key} field`);
  for (let value = from; value <= to; value += step) {
    set.add(field.key === "dow" && value === 7 ? 0 : value);
  }
}

function parseField(token, field) {
  const set = new Set();
  for (const part of String(token).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`empty term in ${field.key} field`);
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (stepPart !== undefined && (!Number.isInteger(step) || step <= 0)) {
      throw new Error(`invalid step "${stepPart}" in ${field.key} field`);
    }
    if (rangePart === "*") {
      addRange(set, field.min, field.max, step, field);
      continue;
    }
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      addRange(set, fieldNumber(a, field), fieldNumber(b, field), step, field);
      continue;
    }
    const value = fieldNumber(rangePart, field);
    if (stepPart === undefined) {
      set.add(value);
    } else {
      addRange(set, value, field.max, step, field);
    }
  }
  return set;
}

// Parse a standard 5-field cron expression into matcher sets. The returned
// object tracks restricted DOM/DOW fields for Vixie-cron day matching.
export function parseCron(expression) {
  const { raw, normalized } = normalizeCronExpression(expression);
  const tokens = normalized.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`expected 5 cron fields, got ${tokens.length}`);
  }
  const spec = { source: raw };
  FIELDS.forEach((field, index) => {
    spec[field.key] = parseField(tokens[index], field);
  });
  spec.domRestricted = tokens[2] !== "*";
  spec.dowRestricted = tokens[4] !== "*";
  return spec;
}

export function isParsedCronSpec(value) {
  return value?.minute instanceof Set && value?.dow instanceof Set;
}
