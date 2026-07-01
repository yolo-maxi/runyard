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

export function createRunCreateStore({
  run,
  id,
  now,
  scrubStoredSecrets,
  addRunEvent,
  createApproval,
  getRun
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

    run(
      runInsertQuery().sql,
      runCreateRecord({
        runId,
        capability,
        input: storedInput,
        options,
        approvalRequired,
        timestamp
      })
    );
    addRunEvent(runId, "run.created", `Run created for ${capability.name}`, {
      capability: capability.slug,
      ...(execution.requested ? { execution } : {})
    });

    if (approvalRequired) {
      const requestedBy = options.requestedBy || "workflow";
      createApproval({
        runId,
        title: `Approve ${capability.name}`,
        description: capability.approvalPolicy?.reason || "This capability requires approval before execution.",
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

    return getRun(runId);
  }

  return { createRun };
}
