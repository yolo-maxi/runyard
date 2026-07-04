import { deepLinks } from "./deepLinks.js";
import {
  ACTION_INPUT_KEYS,
  BRANCH_INPUT_KEYS,
  CHANGE_INPUT_KEYS,
  ORIGIN_INPUT_KEYS,
  PATH_INPUT_KEYS,
  PROJECT_INPUT_KEYS,
  REPO_INPUT_KEYS,
  TITLE_INPUT_KEYS,
  firstContextString,
  firstString,
  truncate,
  uniqueNonempty
} from "./presentation.js";

const SECRET_FIELD_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function sanitizePayloadField(key, value, depth = 0) {
  return SECRET_FIELD_RE.test(key) ? "[redacted]" : sanitizeForDisplay(value, depth);
}

export function sanitizeForDisplay(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(value, 500);
  if (depth >= 3) return "[nested value]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((item) => sanitizeForDisplay(item, depth + 1));
    return value.length > items.length ? [...items, `... ${value.length - items.length} more`] : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 24);
    const output = {};
    for (const [key, item] of entries) {
      output[key] = sanitizePayloadField(key, item, depth + 1);
    }
    if (Object.keys(value).length > entries.length) output._truncated = `${Object.keys(value).length - entries.length} more fields`;
    return output;
  }
  return String(value);
}

export function approvalInput(approval, run = null) {
  const payloadInput = approval?.payload?.input;
  if (payloadInput && typeof payloadInput === "object" && !Array.isArray(payloadInput)) return payloadInput;
  return run?.input && typeof run.input === "object" ? run.input : {};
}

export function approvalPayloadSummary(approval) {
  const payload = approval?.payload || {};
  const summary = {};
  if (payload.capability) summary.capability = payload.capability;
  if (payload.input) summary.input = sanitizeForDisplay(payload.input);
  for (const [key, value] of Object.entries(payload)) {
    if (key === "capability" || key === "input") continue;
    summary[key] = sanitizePayloadField(key, value);
  }
  return summary;
}

function approvalRequestedBy(approval, input) {
  const payloadOrigin = approval?.payload?.origin;
  if (payloadOrigin && typeof payloadOrigin === "object") {
    const name = firstString(payloadOrigin, ["name", "tokenName", "actor", "source"]);
    const via = firstString(payloadOrigin, ["via", "type", "channel"]);
    if (name && via) return `${via}: ${name}`;
    if (name) return name;
  }
  const inputOrigin = firstContextString(input, ORIGIN_INPUT_KEYS);
  return inputOrigin || approval?.requestedBy || "workflow";
}

function approvalProjectContext(input) {
  const project = firstContextString(input, PROJECT_INPUT_KEYS);
  const repo = firstContextString(input, REPO_INPUT_KEYS);
  const pathValue = firstContextString(input, PATH_INPUT_KEYS);
  const branch = firstContextString(input, BRANCH_INPUT_KEYS);
  const targetBranch = firstContextString(input, ["targetBranch", "TARGET_BRANCH"]) || branch;
  const display = uniqueNonempty([project, repo, pathValue]).join(" / ");
  return {
    project,
    repo,
    path: pathValue,
    branch,
    targetBranch,
    display
  };
}

function approvalProposedChange(input, run, approval, deriveRunDescription) {
  const fromInput = firstContextString(input, CHANGE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 700);
  const runDescription = run ? deriveRunDescription?.(run) : "";
  if (runDescription) return truncate(runDescription, 700);
  return truncate(approval?.description || "", 700);
}

function approvalProposedAction(input, run, workflowName, deploy, targetBranch, postRunHooks = []) {
  const fromInput = firstContextString(input, ACTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 320);
  if (!run) return "Mark this approval approved.";
  const parts = [`Queue ${workflowName || "this workflow"} for runner execution`];
  if (postRunHooks.length) parts.push(`with post-run hooks ${postRunHooks.join(", ")}`);
  // Legacy inputs only: `deploy` is deprecated and no longer deploys, but old
  // approval cards should still describe what the caller asked for.
  else if (deploy != null) parts.push(deploy ? "with deploy enabled" : "with deploy disabled");
  if (targetBranch) parts.push(`targeting ${targetBranch}`);
  return `${parts.join(", ")}.`;
}

export function approvalContext(approval, deps = {}) {
  const run = approval?.runId ? deps.getRun?.(approval.runId) : null;
  const input = approvalInput(approval, run);
  const capabilitySlug = approval?.payload?.capability || run?.capabilitySlug || "";
  const capability = capabilitySlug ? deps.getCapability?.(capabilitySlug) : null;
  const workflowName = run?.capabilityName || capability?.name || capabilitySlug || "";
  const deployPresent = hasOwn(input, "deploy");
  const deploy = deployPresent ? Boolean(input.deploy) : null;
  const project = approvalProjectContext(input);
  const proposedChange = approvalProposedChange(input, run, approval, deps.deriveRunDescription);
  return {
    approval: {
      id: approval?.id || "",
      status: approval?.status || "",
      // Explicit taxonomy: kind classifies the question (workflow_gate,
      // escalation, side_effect, custom); resolution is what was decided
      // (approved/rejected/changes_requested/superseded); resolvedVia is which
      // mechanism decided (human/fallback_timer/engine/policy/system).
      kind: approval?.kind || "custom",
      resolution: approval?.resolution || null,
      resolvedVia: approval?.resolvedVia || null,
      // Timed-approval surface: timeoutAt is when the timer elapses (null =
      // blocking approval), timerState is '' | 'fallback_applied' |
      // 'fallback_required'. fallback_required = the timer elapsed with no
      // configured fallback; the card stays pending and needs a human.
      timeoutAt: approval?.timeoutAt || null,
      timerState: approval?.timerState || "",
      fallbackDecision: approval?.fallback?.decision || null
    },
    requestedBy: approvalRequestedBy(approval, input),
    workflow: workflowName
      ? {
          slug: capabilitySlug,
          name: workflowName,
          version: run?.workflowVersion || capability?.version || null,
          deepLink: capabilitySlug ? deepLinks.workflow(capabilitySlug) : ""
        }
      : null,
    project,
    deploy,
    branch: project.branch || "",
    targetBranch: project.targetBranch || "",
    run: run
      ? {
          id: run.id,
          status: run.status,
          title: deps.deriveRunTitle?.(run) || "",
          description: deps.deriveRunDescription?.(run) || "",
          currentStep: run.currentStep,
          deepLink: deepLinks.run(run.id)
        }
      : null,
    inputTitle: firstContextString(input, TITLE_INPUT_KEYS),
    proposedAction: approvalProposedAction(
      input,
      run,
      workflowName,
      deploy,
      project.targetBranch,
      Array.isArray(input?.postRunHooks) ? input.postRunHooks.map((slug) => String(slug || "")).filter(Boolean) : []
    ),
    proposedChange,
    whatHappensIfApproved: run
      ? "The run will move from waiting_approval to queued, then a matching runner can execute it."
      : "This approval will be marked approved.",
    whatHappensIfChangesRequested: run
      ? "The approval will record changes_requested, the run will be cancelled, and the comment should describe the requested changes."
      : "This approval will record changes_requested.",
    whatHappensIfRejected: run ? "The run will be cancelled and will not execute." : "This approval will be marked rejected."
  };
}

export function withApprovalLinks(approval, deps = {}) {
  if (!approval || typeof approval !== "object") return approval;
  return {
    ...approval,
    deepLink: deepLinks.approval(approval.id),
    ...(approval.runId ? { deepLinkRun: deepLinks.run(approval.runId) } : {}),
    context: approvalContext(approval, deps),
    payloadSummary: approvalPayloadSummary(approval)
  };
}
