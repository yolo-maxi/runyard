import {
  artifactInventory as buildArtifactInventory,
  msBetween,
  timestamp,
  valueShape
} from "./runEvidence.js";
import {
  computeDetectedSignals,
  evidenceQuality,
  highlightEvents,
  summarizeDiagnostics,
  topEventTypes
} from "./runObstructionSignals.js";
import { redactText } from "./redaction.js";

export const RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION = "smithers.hub.run-obstruction-analysis.v1";

const GENERATED_RUN_ARTIFACT_NAMES = ["run-retrospective.json", "run-obstruction-analysis.json"];
const DEFAULT_PROMPT_MAX_CHARS = 12_000;

export function redactAnalysisText(value, max = 400) {
  return redactText(value, { max, collapseWhitespace: true });
}

function artifactInventory(artifacts = []) {
  return buildArtifactInventory(artifacts, {
    generatedNames: GENERATED_RUN_ARTIFACT_NAMES,
    limit: 40,
    transform: (value, field) => redactAnalysisText(value, field === "key" || field === "mimeType" ? 80 : 160)
  });
}

export function buildRunObstructionAnalysisPayload({
  run,
  capability = null,
  artifacts = [],
  logSummary = {},
  diagnostics = null,
  generatedAt = timestamp()
} = {}) {
  const timing = {
    queuedMs: msBetween(run?.createdAt, run?.assignedAt || run?.startedAt),
    executionMs: msBetween(run?.startedAt, run?.completedAt),
    totalMs: msBetween(run?.createdAt, run?.completedAt)
  };
  const inventory = artifactInventory(artifacts);
  const highlights = highlightEvents(logSummary, { redactText: redactAnalysisText });
  const outputShape = valueShape(run?.output);
  const diagnosticSummary = summarizeDiagnostics(diagnostics, { redactText: redactAnalysisText });
  const signals = computeDetectedSignals({
    run,
    timing,
    logSummary,
    highlights,
    inventory,
    diagnostics: diagnosticSummary,
    outputShape
  });
  const quality = evidenceQuality(signals, logSummary);
  return {
    schemaVersion: RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION,
    generatedAt,
    run: {
      id: run?.id || "",
      status: run?.status || "",
      capabilitySlug: run?.capabilitySlug || "",
      capabilityName: run?.capabilityName || "",
      workflowVersion: run?.workflowVersion ?? null,
      runnerId: run?.runnerId || "",
      currentStep: redactAnalysisText(run?.currentStep || "", 160),
      createdAt: run?.createdAt || "",
      assignedAt: run?.assignedAt || "",
      startedAt: run?.startedAt || "",
      completedAt: run?.completedAt || "",
      durationMs: run?.durationMs ?? msBetween(run?.startedAt || run?.createdAt, run?.completedAt),
      deepLink: run?.deepLink || "",
      titlePresent: Boolean(run?.title),
      descriptionPresent: Boolean(run?.description),
      inputShape: valueShape(run?.input),
      outputShape
    },
    workflow: capability
      ? {
          slug: capability.slug || run?.capabilitySlug || "",
          name: capability.name || run?.capabilityName || "",
          version: capability.version ?? run?.workflowVersion ?? null,
          engine: capability.workflow?.engine || "",
          entry: redactAnalysisText(capability.workflow?.entry || capability.workflow?.file || "", 220),
          requiredRunnerTags: (capability.requiredRunnerTags || []).slice(0, 20).map((item) => redactAnalysisText(item, 80)),
          requiredSkills: (capability.requiredSkills || []).slice(0, 20).map((item) => redactAnalysisText(item, 80)),
          requiredAgents: (capability.requiredAgents || []).slice(0, 20).map((item) => redactAnalysisText(item, 80)),
          deepLink: capability.deepLink || ""
        }
      : null,
    timing,
    outcome: {
      status: run?.status || "",
      succeeded: run?.status === "succeeded",
      diagnostics: diagnosticSummary
    },
    evidence: {
      quality,
      eventTotals: logSummary.totals || { events: 0, highlights: 0, errors: 0, warnings: 0 },
      eventCategories: (logSummary.categories || []).slice(0, 16),
      eventSeverities: (logSummary.severities || []).slice(0, 8),
      topEventTypes: topEventTypes(logSummary, { redactText: redactAnalysisText }),
      highlightEvents: highlights,
      artifactInventory: inventory,
      detectedSignals: signals
    },
    redaction: {
      rawInputsIncluded: false,
      rawOutputsIncluded: false,
      artifactContentsIncluded: false,
      promptPayloadBounded: true
    }
  };
}

export function hasEnoughEvidenceForObstructionAnalysis(payload) {
  const signals = payload?.evidence?.detectedSignals || {};
  if (!signals.terminalStatus) return false;
  if (payload.run?.status && payload.run.status !== "succeeded") return true;
  if (signals.successfulButPainful) return true;
  if (signals.errorEvents > 0 || signals.warningEvents > 0) return true;
  if (signals.retrySignals > 0 || signals.fallbackSignals > 0) return true;
  if ((signals.longTimingSignals || []).length > 0) return true;
  return false;
}

export function payloadForBudget(payload, maxChars = DEFAULT_PROMPT_MAX_CHARS) {
  const candidates = [
    payload,
    {
      ...payload,
      evidence: {
        ...payload.evidence,
        highlightEvents: (payload.evidence.highlightEvents || []).slice(-12),
        artifactInventory: (payload.evidence.artifactInventory || []).slice(0, 20),
        topEventTypes: (payload.evidence.topEventTypes || []).slice(0, 12)
      },
      outcome: {
        ...payload.outcome,
        diagnostics: payload.outcome.diagnostics
          ? {
              ...payload.outcome.diagnostics,
              timeline: (payload.outcome.diagnostics.timeline || []).slice(-6),
              logExcerpts: (payload.outcome.diagnostics.logExcerpts || []).slice(-4)
            }
          : null
      }
    },
    {
      schemaVersion: payload.schemaVersion,
      generatedAt: payload.generatedAt,
      run: payload.run,
      workflow: payload.workflow,
      timing: payload.timing,
      outcome: {
        status: payload.outcome.status,
        succeeded: payload.outcome.succeeded,
        diagnostics: payload.outcome.diagnostics
          ? {
              status: payload.outcome.diagnostics.status,
              headline: payload.outcome.diagnostics.headline,
              reason: payload.outcome.diagnostics.reason,
              failedStep: payload.outcome.diagnostics.failedStep,
              failureType: payload.outcome.diagnostics.failureType
            }
          : null
      },
      evidence: {
        quality: payload.evidence.quality,
        eventTotals: payload.evidence.eventTotals,
        topEventTypes: (payload.evidence.topEventTypes || []).slice(0, 8),
        highlightEvents: (payload.evidence.highlightEvents || []).slice(-6),
        detectedSignals: payload.evidence.detectedSignals
      },
      redaction: payload.redaction,
      truncation: { reason: "Prompt payload exceeded budget; low-signal lists were removed." }
    }
  ];
  for (const candidate of candidates) {
    const json = JSON.stringify(candidate, null, 2);
    if (json.length <= maxChars) return { payload: candidate, json, truncated: candidate !== payload };
  }
  const minimal = {
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    run: {
      id: payload.run.id,
      status: payload.run.status,
      capabilitySlug: payload.run.capabilitySlug,
      currentStep: payload.run.currentStep,
      createdAt: payload.run.createdAt,
      completedAt: payload.run.completedAt,
      inputShape: payload.run.inputShape,
      outputShape: payload.run.outputShape
    },
    timing: payload.timing,
    outcome: {
      status: payload.outcome.status,
      succeeded: payload.outcome.succeeded
    },
    evidence: {
      quality: payload.evidence.quality,
      eventTotals: payload.evidence.eventTotals,
      detectedSignals: payload.evidence.detectedSignals
    },
    redaction: payload.redaction,
    truncation: { reason: "Prompt payload exceeded budget; minimal evidence only." }
  };
  return { payload: minimal, json: JSON.stringify(minimal, null, 2), truncated: true };
}
