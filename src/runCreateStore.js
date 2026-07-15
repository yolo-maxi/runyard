import {
  normalizeExecutionIntent,
  storeExecutionIntent
} from "./runExecution.js";
import {
  approvalPolicyRequiresRunStartApproval,
  runCreateRecord,
  runInsertQuery,
  runStartApprovalPayload
} from "./runRecords.js";
import { approvalPolicyNotifiesTelegram } from "./operatorRecords.js";
import { normalizeRunBudget, requestedRunBudget } from "./runBudget.js";

export function createRunCreateStore({
  run,
  id,
  now,
  scrubStoredSecrets,
  addRunEvent,
  createApproval,
  getRun,
  getWorkItem,
  addWorkItemEvent,
  syncWorkItemForRun
}) {
  function createRun(capability, input, options = {}) {
    const timestamp = now();
    const approvalRequired = approvalPolicyRequiresRunStartApproval(capability.approvalPolicy);
    const runId = id("run");
    let storedInput = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};

    storedInput = scrubStoredSecrets(storedInput);
    const execution = normalizeExecutionIntent(storedInput, options.execution || {});
    storedInput = storeExecutionIntent(storedInput, execution);
    if (options.origin) {
      storedInput.__origin = {
        ...(storedInput.__origin && typeof storedInput.__origin === "object" ? storedInput.__origin : {}),
        ...options.origin
      };
    }

    // Optional spend budget (options.budget wins over input.budget). Invalid
    // budgets are rejected loudly: silently dropping a cap the caller asked
    // for would let a run spend without the ceiling they thought they set.
    const { budget, issues: budgetIssues } = normalizeRunBudget(requestedRunBudget(storedInput, options));
    if (budgetIssues.length) throw new Error(budgetIssues.join("; "));

    // Optional work-item ("ticket") linkage. Rejected loudly when the item is
    // unknown: silently dropping the link would strand the run outside the
    // ticket the caller thought it was working on.
    const workItemId = options.workItemId ? String(options.workItemId).trim() : "";
    if (workItemId && !getWorkItem(workItemId)) throw new Error(`unknown work item: ${workItemId}`);

    run(
      runInsertQuery().sql,
      runCreateRecord({
        runId,
        capability,
        input: storedInput,
        options,
        approvalRequired,
        budget,
        timestamp
      })
    );
    addRunEvent(runId, "run.created", `Run created for ${capability.name}`, {
      capability: capability.slug,
      ...(execution.requested ? { execution } : {}),
      ...(workItemId ? { workItemId } : {})
    });
    if (workItemId) {
      addWorkItemEvent(workItemId, "work_item.run_linked", `Run ${runId} linked at creation`, {
        runId,
        capability: capability.slug
      });
    }

    if (approvalRequired) {
      const requestedBy = options.requestedBy || "workflow";
      const reason = capability.approvalPolicy?.reason || "This capability requires approval before execution.";
      createApproval({
        runId,
        title: `Approve ${capability.name}`,
        description: reason,
        // Run-start gates hold the run in waiting_approval: approving releases
        // it to the queue, rejecting cancels it before anything executes.
        ask: {
          audience: "operators",
          action: `Release this ${capability.name} run to the queue for runner execution (reject to cancel it before it starts).`,
          reason: String(reason).slice(0, 500)
        },
        requestedBy,
        payload: runStartApprovalPayload({
          capability,
          input: storedInput,
          requestedBy,
          notifyTelegram: approvalPolicyNotifiesTelegram(capability.approvalPolicy),
          origin: options.origin,
          execution
        })
      });
    }

    const created = getRun(runId);
    // A run launched against a ticket moves it on the board immediately
    // (queued -> In motion, waiting_approval -> Needs decision) — the board
    // reflects the launch without waiting for the runner to pick it up.
    if (workItemId) syncWorkItemForRun?.(created, { trigger: "run_created" });
    return created;
  }

  return { createRun };
}
