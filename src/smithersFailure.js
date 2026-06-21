// Pure helper: pull the *real* failing-node error out of a Smithers run state
// (and, as a fallback, its event trace) so the Hub child run records a
// diagnostic error instead of the opaque "smithers run X ended in state
// 'failed'". The supervising run-smithers watcher relies on this richer error
// to recognise deterministic workflow-code failures (a TypeError in a workflow
// template, a failed node with a JS stack) and decide whether a one-shot code
// repair is warranted. Side-effect free so it can be unit-tested without a live
// Smithers engine.

const ERROR_HINT =
  /\b(error|typeerror|referenceerror|syntaxerror|rangeerror|exception|stack|cannot read|is not a function|is not defined|is not iterable|unexpected token|unhandled|failed|throw)\b/i;

const FAILED_STATES = new Set(["failed", "errored", "error", "rejected", "crashed"]);

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (typeof value.stack === "string" && value.stack.trim()) return value.stack;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Returns { failedStep, error }. `error` is empty when no failure signal can be
// found, in which case callers should fall back to the generic state message.
export function extractSmithersFailure(state = {}, eventLines = []) {
  let failedStep = "";
  let error = "";

  const steps = Array.isArray(state?.steps) ? state.steps : [];
  for (const step of steps) {
    const status = String(step?.state || step?.status || "").toLowerCase();
    const stepError = asText(step?.error ?? step?.failure ?? step?.result?.error);
    if (FAILED_STATES.has(status) || (stepError && ERROR_HINT.test(stepError))) {
      failedStep = step?.id || step?.nodeId || step?.name || failedStep;
      if (stepError) {
        error = stepError;
        break;
      }
    }
  }

  if (!error) error = asText(state?.runState?.error ?? state?.error ?? state?.run?.error);

  // Fall back to the most recent error-ish event line when the structured state
  // did not carry a node error (older Smithers builds surface failures only in
  // the event stream).
  if (!error && Array.isArray(eventLines)) {
    for (let i = eventLines.length - 1; i >= 0; i--) {
      const line = eventLines[i];
      let text = typeof line === "string" ? line : asText(line);
      if (typeof line === "string") {
        try {
          const obj = JSON.parse(line);
          text = asText(obj.data ?? obj.error ?? obj.message ?? line);
        } catch {
          /* keep raw */
        }
      }
      if (text && ERROR_HINT.test(text)) {
        error = text;
        break;
      }
    }
  }

  return { failedStep: String(failedStep || ""), error: String(error || "").trim().slice(0, 2000) };
}
