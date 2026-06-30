import { deepLinks } from "./deepLinks.js";
import {
  BRANCH_INPUT_KEYS,
  DESCRIPTION_INPUT_KEYS,
  ORIGIN_INPUT_KEYS,
  PROJECT_INPUT_KEYS,
  TITLE_INPUT_KEYS,
  firstContextString,
  firstString,
  normalizeOrigin,
  truncate,
  uniqueNonempty
} from "./presentation.js";
import { executionIntentFromInput } from "./runExecution.js";
import { quickFailedStep, quickReasonHint } from "./runDiagnostics.js";
import { SUPERVISOR_CAPABILITY_SLUG, stripSupervisionInternals } from "./supervision.js";

export function deriveRunTitle(run) {
  const fromInput = firstString(run.input, TITLE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 90);
  return run.capabilityName || run.capabilitySlug || "Run";
}

export function deriveRunDescription(run) {
  const fromInput = firstString(run.input, DESCRIPTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 240);
  const titleField = firstString(run.input, TITLE_INPUT_KEYS);
  if (titleField && titleField.length > 90) return truncate(titleField, 240);
  const parts = [];
  if (run.capabilityName) parts.push(run.capabilityName);
  if (run.currentStep) parts.push(run.currentStep);
  return truncate(parts.join(" — "), 240);
}

export function normalizeSupervisionLineage(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function runPresentation(run, deps = {}) {
  if (!run || typeof run !== "object") return { run, input: {}, output: null, supervision: null };
  const storedInput = run.input && typeof run.input === "object" && !Array.isArray(run.input) ? run.input : {};
  const rawInput = stripSupervisionInternals(run.input || {});
  const rawOutput = run.output && typeof run.output === "object" && !Array.isArray(run.output) ? run.output : null;
  const superviseOutput = rawOutput?.outputs?.supervise && typeof rawOutput.outputs.supervise === "object" && !Array.isArray(rawOutput.outputs.supervise)
    ? rawOutput.outputs.supervise
    : rawOutput;
  const isHubSupervisionEnvelope = typeof storedInput.__supervisionToken === "string" && storedInput.__supervisionToken.trim();
  const wrappedCapability = run.capabilitySlug === SUPERVISOR_CAPABILITY_SLUG && isHubSupervisionEnvelope && typeof rawInput.wrappedCapability === "string"
    ? rawInput.wrappedCapability.trim()
    : "";
  if (!wrappedCapability) {
    return { run, input: rawInput, output: run.output, supervision: null };
  }

  const wrappedInput = rawInput.wrappedInput && typeof rawInput.wrappedInput === "object" && !Array.isArray(rawInput.wrappedInput)
    ? stripSupervisionInternals(rawInput.wrappedInput)
    : {};
  const wrappedCapabilityRecord = deps.getCapability?.(wrappedCapability);
  const childRunId = typeof superviseOutput?.wrappedRunId === "string"
    ? superviseOutput.wrappedRunId
    : typeof superviseOutput?.wrapped_run_id === "string"
      ? superviseOutput.wrapped_run_id
      : "";
  const childRun = childRunId ? deps.getRun?.(childRunId) : null;
  const childOutput = childRun && childRun.output !== undefined ? childRun.output : null;
  const lineage = normalizeSupervisionLineage(superviseOutput?.lineage);
  const effectiveRun = {
    ...run,
    capabilitySlug: wrappedCapability,
    capabilityName: wrappedCapabilityRecord?.name || wrappedCapability,
    input: wrappedInput,
    output: childOutput
  };
  return {
    run: effectiveRun,
    input: wrappedInput,
    output: childOutput,
    supervision: {
      supervisorRunId: run.id,
      supervisorCapabilitySlug: SUPERVISOR_CAPABILITY_SLUG,
      childRunId,
      wrappedCapability,
      wrappedCapabilityName: wrappedCapabilityRecord?.name || wrappedCapability,
      outcome: superviseOutput?.outcome || "",
      attempts: lineage.length,
      lineage,
      ...(superviseOutput?.approval ? { approval: superviseOutput.approval } : {})
    }
  };
}

export function outputNode(output, name) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const nodes = output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
  const node = nodes?.[name];
  return node && typeof node === "object" && !Array.isArray(node) ? node : null;
}

export function runOutcomeSummary(run) {
  const output = run?.output && typeof run.output === "object" && !Array.isArray(run.output) ? run.output : null;
  const baseline = outputNode(output, "baseline");
  const commit = outputNode(output, "commit");
  const review = outputNode(output, "review");
  const files = Array.isArray(commit?.files) ? commit.files.map((file) => String(file || "").trim()).filter(Boolean) : [];
  const improvements = Array.isArray(review?.improvements) ? review.improvements : [];
  const noChangeRationale = Boolean(
    review
    && improvements.length === 0
    && (
      String(review.summary || "").trim()
      || (Array.isArray(review.risks) && review.risks.some((risk) => String(risk || "").trim()))
      || (Array.isArray(review.userPain) && review.userPain.some((line) => String(line || "").trim()))
    )
  );
  let workProduct = "none";
  if (files.length) workProduct = `${files.length} changed file${files.length === 1 ? "" : "s"}`;
  else if (noChangeRationale) workProduct = "explicit no-change review";
  else if (output) workProduct = "output only";
  return {
    repo: String(baseline?.repoDir || run?.project || "").trim() || "unresolved",
    changedFiles: files.length,
    files,
    workProduct,
    classification: run?.status || "unknown"
  };
}

export function runOrigin(run) {
  const input = run?.input || {};
  const candidates = [
    normalizeOrigin(input.__origin),
    normalizeOrigin(input.origin),
    normalizeOrigin(input.source),
    normalizeOrigin(input.context?.origin),
    normalizeOrigin(input.metadata?.origin)
  ].filter(Boolean);
  const origin = candidates[0] || null;
  if (!origin) {
    const text = firstContextString(input, ORIGIN_INPUT_KEYS);
    return text ? { label: text } : null;
  }
  if (!origin.label) {
    const bits = uniqueNonempty([origin.type, origin.name, origin.chat, origin.thread, origin.messageId]);
    origin.label = bits.join(": ");
  }
  return origin.label ? origin : null;
}

export function runDurationMs(run, { now = () => new Date().toISOString() } = {}) {
  if (!run?.createdAt) return null;
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = Date.parse(run.completedAt || now());
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

export function buildQueueIndex(runs) {
  const queued = (runs || [])
    .filter((run) => run && run.status === "queued")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const map = new Map();
  queued.forEach((run, index) => map.set(run.id, index + 1));
  return { map, total: queued.length };
}

export function withRunLinks(run, queueIndex = null, deps = {}) {
  if (!run || typeof run !== "object") return run;
  const presentation = runPresentation(run, deps);
  const visibleRun = presentation.run || run;
  const visibleInput = presentation.input || {};
  const visibleOutput = presentation.output;
  const origin = runOrigin(run);
  const execution = executionIntentFromInput(visibleInput || {});
  const reasonHint = quickReasonHint(visibleRun);
  const failedStep = quickFailedStep(visibleRun);
  const queue = run.status === "queued" && queueIndex
    ? { position: queueIndex.map.get(run.id) || null, total: queueIndex.total }
    : null;
  return {
    ...run,
    capabilitySlug: visibleRun.capabilitySlug,
    capabilityName: visibleRun.capabilityName,
    input: visibleInput,
    output: visibleOutput,
    ...(presentation.supervision
      ? {
          actualCapabilitySlug: run.capabilitySlug,
          actualCapabilityName: run.capabilityName,
          supervision: presentation.supervision
        }
      : {}),
    title: deriveRunTitle(visibleRun),
    description: deriveRunDescription(visibleRun),
    project: firstContextString(visibleInput, PROJECT_INPUT_KEYS),
    branch: firstContextString(visibleInput, BRANCH_INPUT_KEYS),
    origin,
    originLabel: origin?.label || "",
    outcomeSummary: runOutcomeSummary(visibleRun),
    execution,
    durationMs: runDurationMs(run),
    reasonHint,
    failedStep,
    ...(queue ? { queue } : {}),
    deepLink: deepLinks.run(run.id),
    deepLinkLogs: deepLinks.runLogs(run.id),
    deepLinkArtifacts: deepLinks.runArtifacts(run.id),
    ...(visibleRun.capabilitySlug ? { deepLinkWorkflow: deepLinks.workflow(visibleRun.capabilitySlug) } : {})
  };
}
