import { humanizeApprovalAudience, normalizeApprovalAsk } from "./approvalAsk.js";
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

// --- Humanized vocabulary -----------------------------------------------
// Raw enums (waiting_approval, changes_requested, fallback_timer, ...) are
// storage words. Anywhere a human reads an approval — web card, Telegram,
// run diagnostics — these label maps do the talking; the raw value stays
// available in JSON for machines.

const APPROVAL_KIND_LABELS = {
  workflow_gate: "Workflow gate",
  escalation: "Needs a decision",
  side_effect: "Side effect",
  custom: "Approval"
};

const APPROVAL_RESOLUTION_LABELS = {
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  superseded: "Superseded — the run ended first"
};

const APPROVAL_RESOLVED_VIA_LABELS = {
  human: "decided by a human",
  fallback_timer: "decided by the timer (autopilot)",
  engine: "decided on the runner",
  policy: "auto-approved by policy",
  system: "closed by the system"
};

const RUN_STATUS_LABELS = {
  queued: "Queued",
  assigned: "Assigned to a runner",
  running: "Running",
  pending: "Pending",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  rejected: "Rejected"
};

export function approvalKindLabel(kind) {
  return APPROVAL_KIND_LABELS[kind] || APPROVAL_KIND_LABELS.custom;
}

export function approvalResolutionLabel(resolution) {
  if (!resolution) return "";
  if (String(resolution).startsWith("option:")) return `Chose: ${String(resolution).slice("option:".length)}`;
  return APPROVAL_RESOLUTION_LABELS[resolution] || String(resolution).replace(/_/g, " ");
}

export function approvalResolvedViaLabel(resolvedVia) {
  return APPROVAL_RESOLVED_VIA_LABELS[resolvedVia] || "";
}

export function humanRunStatusLabel(status) {
  if (!status) return "";
  return RUN_STATUS_LABELS[status] || String(status).replace(/_/g, " ");
}

// One sentence for a resolved card: "Approved — decided by the timer
// (autopilot)". Shared by web, Telegram, and diagnostics so the story reads
// the same everywhere.
export function approvalResolutionSentence(approval) {
  if (!approval || approval.status === "pending") return "";
  const resolution = approvalResolutionLabel(approval.resolution || approval.decision) || "Resolved";
  const via = approvalResolvedViaLabel(approval.resolvedVia);
  return via ? `${resolution} — ${via}` : resolution;
}

// --- Per-kind consequence table -------------------------------------------
// The honest answers to "what will my decision do", computed from what
// resolveApproval / the engine bridge actually perform — never kind-agnostic
// boilerplate. resolveApproval only transitions a run that is sitting in
// waiting_approval; engine gates ride the runner's smithers apply; escalation
// cards currently only record the decision (their run already ended).
export function approvalConsequences(approval, run = null) {
  const kind = approval?.kind || "custom";
  const runWaiting = run?.status === "waiting_approval";

  if (kind === "workflow_gate") {
    if (runWaiting) {
      return {
        ifApproved: "The held run is released and the workflow resumes past this gate.",
        ifChangesRequested:
          "The run is cancelled and your note tells the requester what to change before trying again.",
        ifRejected: "The run is cancelled — a human “no” is a decision, not a failure."
      };
    }
    return {
      ifApproved: "Your decision is applied to the paused workflow on the runner, and it resumes past this gate.",
      ifChangesRequested:
        "Applied to the workflow as a deny with your note attached; the workflow's own deny path decides what happens next. The run keeps running.",
      ifRejected:
        "Applied to the workflow as a deny; the workflow's own deny path decides what happens next (some workflows continue with the denial recorded)."
    };
  }

  if (kind === "escalation") {
    // Honest until option handlers land: resolving an escalation records the
    // operator's call but does not move the already-ended run.
    return {
      ifApproved:
        "Records your go-ahead on this card. The run already ended and is not restarted by this — re-run it from the run page.",
      ifChangesRequested:
        "Records that the workflow or input needs fixing first; your note is the guidance. The run itself is not changed.",
      ifRejected: "Records that this run should be left as it ended. Nothing is retried."
    };
  }

  if (kind === "side_effect") {
    return {
      ifApproved: "The gated side effect is allowed to run. The run's own completed work is unchanged.",
      ifChangesRequested: "The side effect is skipped and your note tells the requester what to change.",
      ifRejected: "The side effect is skipped. The run's completed work is unaffected."
    };
  }

  if (runWaiting) {
    return {
      ifApproved: "The held run is released to the queue, and a matching runner executes it.",
      ifChangesRequested: "The run is cancelled and your note tells the requester what to change.",
      ifRejected: "The run is cancelled and will not execute."
    };
  }
  if (run) {
    const status = humanRunStatusLabel(run.status) || "not waiting on this card";
    return {
      ifApproved: `Your decision is recorded on this card. The linked run is ${status.toLowerCase()} and is not changed by it.`,
      ifChangesRequested: "Your note is recorded on this card; the linked run is not changed by it.",
      ifRejected: "Your decision is recorded on this card; the linked run is not changed by it."
    };
  }
  return {
    ifApproved: "This approval is marked approved.",
    ifChangesRequested: "This approval records that changes are needed; your note describes them.",
    ifRejected: "This approval is marked rejected."
  };
}

// What silence means, from the card's actual timer configuration. A blocking
// card never invents a decision; a timed card with a fallback decides itself;
// an elapsed timer without a fallback is flagged and keeps waiting.
export function approvalIfIgnored(approval, run = null) {
  const holdsRun = run && ["waiting_approval", "running", "assigned", "queued", "pending"].includes(run.status);
  const heldSuffix = holdsRun ? " The linked run is held open — waiting never fails it." : "";
  if (!approval?.timeoutAt) {
    return `Nothing happens by itself: this card waits until someone decides.${heldSuffix}`;
  }
  const fallbackDecision = approval.fallback?.decision || "";
  if (approval.timerState === "fallback_required") {
    return `The timer already elapsed with no automatic decision configured — this needs a human now.${heldSuffix}`;
  }
  if (fallbackDecision) {
    const label = approvalResolutionLabel(fallbackDecision) || fallbackDecision;
    return `If nobody decides by ${approval.timeoutAt}, “${label}” is applied automatically (autopilot).`;
  }
  return `When the timer elapses at ${approval.timeoutAt}, the card is flagged as needing a decision and keeps waiting — no decision is invented.${heldSuffix}`;
}

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
  // Only a run actually held in waiting_approval is released by approving;
  // claiming "queue for execution" on any other run would be a lie.
  if (run.status !== "waiting_approval") return "Record a decision on this card.";
  const parts = [`Queue ${workflowName || "this workflow"} for runner execution`];
  if (postRunHooks.length) parts.push(`with post-run hooks ${postRunHooks.join(", ")}`);
  // Legacy inputs only: `deploy` is deprecated and no longer deploys, but old
  // approval cards should still describe what the caller asked for.
  else if (deploy != null) parts.push(deploy ? "with deploy enabled" : "with deploy disabled");
  if (targetBranch) parts.push(`targeting ${targetBranch}`);
  return `${parts.join(", ")}.`;
}

// The heuristic (input-key scavenging) ask, for cards created without a
// declared ask. Explicitly marked derived: true so no surface can present a
// guessed question as an authored one.
function deriveApprovalAsk(approval, { input, run, workflowName, deploy, targetBranch }) {
  const kind = approval?.kind || "custom";
  const reason =
    truncate(approval?.description || "", 500) || "The requester asked for a human decision before continuing.";
  // An input field explicitly named `proposedAction` is a declared action from
  // the creator, not key-name scavenging — honor it for every kind. The
  // broader guesswork keys (action/operation/command) stay custom-only.
  const explicitAction = truncate(firstContextString(input, ["proposedAction"]), 320);
  if (kind === "workflow_gate") {
    const nodeId = String(approval?.payload?.nodeId || "").trim();
    return {
      audience: "operators",
      action:
        explicitAction ||
        (run?.status === "waiting_approval"
          ? `Release the held run past this gate${nodeId ? ` ('${nodeId}')` : ""}.`
          : `Apply your decision to the paused workflow gate${nodeId ? ` '${nodeId}'` : ""} on the runner.`),
      reason,
      derived: true
    };
  }
  if (kind === "escalation") {
    return {
      audience: "operators",
      action: explicitAction || "Record how this run should proceed after autonomous recovery gave up.",
      reason,
      derived: true
    };
  }
  if (kind === "side_effect") {
    return {
      audience: "admins",
      action: explicitAction || "Allow or skip the gated side effect before it runs.",
      reason,
      derived: true
    };
  }
  const action = approvalProposedAction(
    input,
    run,
    workflowName,
    deploy,
    targetBranch,
    Array.isArray(input?.postRunHooks) ? input.postRunHooks.map((slug) => String(slug || "")).filter(Boolean) : []
  );
  return { audience: "operators", action, reason, derived: true };
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
  const kind = approval?.kind || "custom";
  // The declared ask wins; heuristic derivation survives only as the fallback
  // for cards without one (legacy rows, ad-hoc custom cards).
  const storedAsk = normalizeApprovalAsk(approval?.ask);
  const ask = storedAsk
    ? { ...storedAsk, derived: false }
    : deriveApprovalAsk(approval, { input, run, workflowName, deploy, targetBranch: project.targetBranch });
  // proposedChange: for cards with an authored description (engine gates carry
  // the gate's own summary there) prefer it verbatim; scavenge run input only
  // for ask-less custom cards, where it is the best available guess.
  const heuristicChange = !storedAsk && kind === "custom";
  const proposedChange = heuristicChange
    ? approvalProposedChange(input, run, approval, deps.deriveRunDescription)
    : truncate(approval?.description || "", 700) || approvalProposedChange(input, run, approval, deps.deriveRunDescription);
  const consequences = approvalConsequences(approval, run);
  return {
    approval: {
      id: approval?.id || "",
      status: approval?.status || "",
      statusLabel: approval?.status === "pending" ? "Pending decision" : "Resolved",
      // Explicit taxonomy: kind classifies the question (workflow_gate,
      // escalation, side_effect, custom); resolution is what was decided
      // (approved/rejected/changes_requested/superseded); resolvedVia is which
      // mechanism decided (human/fallback_timer/engine/policy/system). The
      // *Label fields are the only forms surfaces should print.
      kind,
      kindLabel: approvalKindLabel(kind),
      resolution: approval?.resolution || null,
      resolutionLabel: approvalResolutionLabel(approval?.resolution) || null,
      resolvedVia: approval?.resolvedVia || null,
      resolvedViaLabel: approvalResolvedViaLabel(approval?.resolvedVia) || null,
      resolutionSentence: approvalResolutionSentence(approval) || null,
      // Timed-approval surface: timeoutAt is when the timer elapses (null =
      // blocking approval), timerState is '' | 'fallback_applied' |
      // 'fallback_required'. fallback_required = the timer elapsed with no
      // configured fallback; the card stays pending and needs a human.
      timeoutAt: approval?.timeoutAt || null,
      timerState: approval?.timerState || "",
      fallbackDecision: approval?.fallback?.decision || null,
      fallbackDecisionLabel: approvalResolutionLabel(approval?.fallback?.decision) || null
    },
    // The six answers every surface must render: who / what / why /
    // if-ignored / options / what-next. `ask.derived` distinguishes an
    // authored question from a best-effort guess.
    ask: {
      ...ask,
      audienceLabel: humanizeApprovalAudience(ask.audience)
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
          statusLabel: humanRunStatusLabel(run.status),
          title: deps.deriveRunTitle?.(run) || "",
          description: deps.deriveRunDescription?.(run) || "",
          currentStep: run.currentStep,
          deepLink: deepLinks.run(run.id)
        }
      : null,
    inputTitle: firstContextString(input, TITLE_INPUT_KEYS),
    proposedAction: ask.action,
    proposedChange,
    whatHappensIfApproved: consequences.ifApproved,
    whatHappensIfChangesRequested: consequences.ifChangesRequested,
    whatHappensIfRejected: consequences.ifRejected,
    whatHappensIfIgnored: approvalIfIgnored(approval, run)
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
