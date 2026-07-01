import {
  normalizeCronExpression,
  parseCron
} from "./cronParser.js";

const ORDINAL_DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL_MONTH = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Best-effort plain-language summary of common patterns. Falls back to echoing
// the normalized expression; the UI always pairs this with concrete next-run
// times, so an imperfect description is never the only signal.
export function describeCron(expression, tz = "UTC") {
  let tokens;
  try {
    const raw = String(expression || "").trim();
    const { normalized } = normalizeCronExpression(raw);
    parseCron(normalized); // validate
    tokens = normalized.split(/\s+/);
  } catch (error) {
    return `Invalid schedule (${error.message})`;
  }
  const [min, hour, dom, month, dow] = tokens;
  const tzSuffix = tz && tz !== "UTC" ? ` ${tz}` : " UTC";
  const at = (h, m) => `${pad2(Number(h))}:${pad2(Number(m))}${tzSuffix}`;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyMin[1]} minutes`;
  }
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && everyHour && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyHour[1]} hours`;
  }
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Hourly at :${pad2(Number(min))}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (dom === "*" && month === "*" && dow === "*") return `Daily at ${at(hour, min)}`;
    if (dom === "*" && month === "*" && /^\d+$/.test(dow)) {
      const day = ORDINAL_DOW[Number(dow) === 7 ? 0 : Number(dow)];
      return `Weekly on ${day} at ${at(hour, min)}`;
    }
    if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
      return `Monthly on day ${Number(dom)} at ${at(hour, min)}`;
    }
    if (/^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
      return `Yearly on ${ORDINAL_MONTH[Number(month)]} ${Number(dom)} at ${at(hour, min)}`;
    }
  }
  return `Custom schedule (${tokens.join(" ")})${tzSuffix === " UTC" ? "" : ` in ${tz}`}`;
}
