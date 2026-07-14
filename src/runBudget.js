import { RUN_TERMINAL } from "./runLifecyclePolicy.js";

// Optional per-run spend budgets.
//
// A budget is a hard ceiling, not advisory: the metering gateway refuses the
// next provider call once the run's aggregate usage reaches it, and the Hub
// stops the run with the distinct terminal status `budget_exceeded` (see
// RUN_FAILURE_CLASSES) so callers can tell a budget stop from a generic
// failure. Budgets ride run creation as `budget` (top-level option or
// `input.budget`) and are persisted on the run row.
export const RUN_BUDGET_FIELDS = ["maxTokens", "maxCostMicros"];

const MAX_BUDGET_VALUE = 1_000_000_000_000; // 1T tokens / $1M — anything above is a typo

// Normalize a caller-supplied budget. Returns { budget, issues }:
//  - budget null when nothing (valid) was requested;
//  - issues lists every rejected field, value never echoed beyond its number.
export function normalizeRunBudget(value) {
  if (value === undefined || value === null) return { budget: null, issues: [] };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { budget: null, issues: ["budget must be an object like { maxTokens, maxCostMicros }"] };
  }
  const budget = {};
  const issues = [];
  for (const field of RUN_BUDGET_FIELDS) {
    const raw = value[field];
    if (raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0 || num > MAX_BUDGET_VALUE) {
      issues.push(`budget.${field} must be a positive number (got ${JSON.stringify(raw)})`);
      continue;
    }
    budget[field] = Math.floor(num);
  }
  const unknown = Object.keys(value).filter((key) => !RUN_BUDGET_FIELDS.includes(key));
  if (unknown.length) {
    issues.push(`budget has unknown field(s): ${unknown.join(", ")} (allowed: ${RUN_BUDGET_FIELDS.join(", ")})`);
  }
  return { budget: Object.keys(budget).length ? budget : null, issues };
}

// Budget requested at run creation: explicit option wins over `input.budget`.
export function requestedRunBudget(input, options = {}) {
  if (options.budget !== undefined && options.budget !== null) return options.budget;
  return input && typeof input === "object" ? input.budget : undefined;
}

// Compare a run's aggregate usage against its budget. Returns
// { exceeded: false } or { exceeded: true, dimension, reason } — `reason`
// becomes the run error and the budget-stop event message, so it states both
// numbers plainly.
export function evaluateRunBudget(budget, usage) {
  if (!budget || typeof budget !== "object") return { exceeded: false };
  const totals = usage && typeof usage === "object" ? usage : {};
  const totalTokens = Number(totals.totalTokens) || 0;
  const costMicros = Number(totals.costMicros) || 0;
  if (budget.maxTokens && totalTokens >= budget.maxTokens) {
    return {
      exceeded: true,
      dimension: "tokens",
      reason: `budget exceeded: ${totalTokens} tokens used, budget.maxTokens is ${budget.maxTokens}`
    };
  }
  if (budget.maxCostMicros && costMicros >= budget.maxCostMicros) {
    return {
      exceeded: true,
      dimension: "cost",
      reason: `budget exceeded: cost ${(costMicros / 1_000_000).toFixed(4)} USD used, budget.maxCostMicros is ${budget.maxCostMicros} (${(budget.maxCostMicros / 1_000_000).toFixed(4)} USD)`
    };
  }
  return { exceeded: false };
}

// Legibility companion to evaluateRunBudget: pairs each budget ceiling with
// what the run's aggregate has actually consumed, so every payload that
// carries a budget can also say "spent / limit / remaining" without clients
// re-deriving the arithmetic. Null when no budget is set. percentUsed is the
// worst dimension (the one that will stop the run first); nearLimit trips at
// 80% so UIs can warn before the hard stop.
export const BUDGET_NEAR_LIMIT_PERCENT = 80;

export function runBudgetStatus(budget, usage) {
  if (!budget || typeof budget !== "object") return null;
  const totals = usage && typeof usage === "object" ? usage : {};
  const status = {};
  const percents = [];
  if (budget.maxTokens) {
    const used = Number(totals.totalTokens) || 0;
    status.maxTokens = budget.maxTokens;
    status.tokensUsed = used;
    status.tokensRemaining = Math.max(0, budget.maxTokens - used);
    status.tokensPercentUsed = Math.min(100, Math.round((used / budget.maxTokens) * 100));
    percents.push(status.tokensPercentUsed);
  }
  if (budget.maxCostMicros) {
    const used = Number(totals.costMicros) || 0;
    status.maxCostMicros = budget.maxCostMicros;
    status.costMicrosUsed = used;
    status.costMicrosRemaining = Math.max(0, budget.maxCostMicros - used);
    status.costPercentUsed = Math.min(100, Math.round((used / budget.maxCostMicros) * 100));
    percents.push(status.costPercentUsed);
  }
  if (!percents.length) return null;
  status.percentUsed = Math.max(...percents);
  status.nearLimit = status.percentUsed >= BUDGET_NEAR_LIMIT_PERCENT;
  return status;
}

// A run's `budgetStop` presentation: non-null only when the run terminated on
// its budget, so API/UI/delegated callers get one stable place to look.
export function runBudgetStop(run) {
  if (!run || run.status !== "budget_exceeded") return null;
  return {
    stopped: true,
    reason: run.error || "run budget exceeded",
    budget: run.budget || null
  };
}

// Hard-stop enforcement. Called after every accepted usage record (ingest
// endpoint + gateway) and before the gateway forwards a call upstream. When
// the run's aggregate has reached its budget this emits `run.budget.exceeded`
// and transitions the run to the terminal `budget_exceeded` status; the runner
// observes the terminal status on its next poll and cancels the detached
// engine run, so no further provider calls are made on RunYard's dime.
export function createRunBudgetEnforcer({ getRun, addRunEvent, transitionRun, recordRunTerminalArtifacts, now }) {
  function enforceRunBudget(runOrId) {
    const run = runOrId && typeof runOrId === "object" ? runOrId : getRun(runOrId);
    if (!run?.budget) return { exceeded: false };
    const evaluation = evaluateRunBudget(run.budget, run.usage);
    if (!evaluation.exceeded) return evaluation;
    // A terminal run (including an earlier budget stop) must not re-emit the
    // breach event on every late usage report that trickles in.
    if (RUN_TERMINAL.has(run.status)) return { ...evaluation, stopped: false, alreadyTerminal: true };
    addRunEvent(run.id, "run.budget.exceeded", evaluation.reason, {
      budget: run.budget,
      dimension: evaluation.dimension,
      totals: {
        totalTokens: Number(run.usage?.totalTokens) || 0,
        costMicros: Number(run.usage?.costMicros) || 0
      }
    });
    const result = transitionRun(run.id, "budget_exceeded", {
      current_step: "budget exceeded",
      error: evaluation.reason,
      completed_at: now()
    });
    const stopped = Boolean(result.ok && !result.idempotent);
    if (stopped) recordRunTerminalArtifacts(run.id);
    return { ...evaluation, stopped };
  }
  return { enforceRunBudget };
}
