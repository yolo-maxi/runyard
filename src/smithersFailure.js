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

function eventFailure(line) {
  let obj = line;
  if (typeof line === "string") {
    try {
      obj = JSON.parse(line);
    } catch {
      return { failedStep: "", error: ERROR_HINT.test(line) ? line : "" };
    }
  }
  if (!obj || typeof obj !== "object") return { failedStep: "", error: "" };
  const type = String(obj.type || obj.payload?.type || "");
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : obj;
  const nodeId = String(payload.nodeId || payload.correlation?.nodeId || "");
  const errorText = asText(payload.error ?? payload.data?.error ?? obj.error ?? obj.data ?? obj.message);
  // NodeFailed carries the real workflow/node stack. Prefer it over the later
  // RunFailed scheduler wrapper, whose stack often starts at Smithers internals.
  if (/NodeFailed/i.test(type) && errorText) return { failedStep: nodeId, error: errorText };
  if (errorText && ERROR_HINT.test(errorText)) return { failedStep: nodeId, error: errorText };
  return { failedStep: "", error: "" };
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

  // Event traces often contain a specific NodeFailed payload followed by a
  // generic RunFailed scheduler wrapper. Always scan for the specific node
  // failure and prefer it over a generic run-level error when present.
  if (Array.isArray(eventLines)) {
    for (let i = eventLines.length - 1; i >= 0; i--) {
      const raw = eventLines[i];
      const event = eventFailure(eventLines[i]);
      const isNodeFailure = /NodeFailed/i.test(String(typeof raw === "string" ? raw : raw?.type || raw?.payload?.type || ""));
      if (event.error && isNodeFailure) {
        if (event.failedStep) failedStep = event.failedStep;
        error = event.error;
        break;
      }
      if (event.error && !error) {
        if (event.failedStep) failedStep = event.failedStep;
        error = event.error;
      }
    }
  }

  return { failedStep: String(failedStep || ""), error: String(error || "").trim().slice(0, 2000) };
}
