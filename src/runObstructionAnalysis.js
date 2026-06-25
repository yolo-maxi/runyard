export const RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME = "run-obstruction-analysis.json";
export const RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION = "smithers.hub.run-obstruction-analysis.v1";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const GENERATED_RUN_ARTIFACT_NAMES = new Set(["run-retrospective.json", RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME]);
const OBSTRUCTION_SEVERITIES = ["none", "low", "medium", "high"];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];
const DEFAULT_PROMPT_MAX_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You analyze terminal agent workflow runs for obstructions.
Return only valid JSON. Separate evidence from inference. Be conservative when evidence is thin.
Look for blockers, failed steps, missing context, unclear goals, tool/path/env/runner issues,
approval friction, retries, repeated errors, fallback behavior, long queue/execution/total time,
human corrections, workflow/agent/skill design issues, artifact/output gaps, and successful but
painful runs. Recommendations are proposals only. Do not suggest or perform automatic mutation.`;

const TEXT_REDACTION_RULES = [
  { re: /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(x-api-key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /((?:api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /\bshub_[A-Za-z0-9_=-]+\b/g, replace: "shub_[redacted]" },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: "sk-[redacted]" },
  { re: /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, replace: "gh_[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+\b/g, replace: "[redacted-jwt]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[redacted-private-key]" }
];

let injectedAnalyzer = null;

function timestamp() {
  return new Date().toISOString();
}

function truncate(text, max = 400) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function redactAnalysisText(value, max = 400) {
  let text = String(value ?? "");
  for (const { re, replace } of TEXT_REDACTION_RULES) text = text.replace(re, replace);
  return truncate(text, max);
}

function msBetween(start, end) {
  const a = Date.parse(start || "");
  const b = Date.parse(end || "");
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

function keysOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 80);
}

function valueShape(value, depth = 0) {
  if (value == null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: depth < 1 && value.length ? valueShape(value[0], depth + 1) : null
    };
  }
  if (typeof value === "object") {
    const keys = keysOf(value);
    return {
      type: "object",
      keys,
      fields:
        depth < 1
          ? Object.fromEntries(keys.slice(0, 24).map((key) => [key, valueShape(value[key], depth + 1)]))
          : {}
    };
  }
  return { type: typeof value };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArtifactMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const safeKeys = new Set(["generatedBy", "sourceNode", "sourceField", "kind", "schemaVersion", "smithersRunId"]);
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => safeKeys.has(key))
      .slice(0, 20)
      .map(([key, value]) => [redactAnalysisText(key, 80), redactAnalysisText(value, 160)])
  );
}

function artifactInventory(artifacts = []) {
  return (artifacts || [])
    .filter((artifact) => !GENERATED_RUN_ARTIFACT_NAMES.has(artifact?.name))
    .map((artifact) => ({
      id: artifact.id || "",
      name: redactAnalysisText(artifact.name || "", 160),
      mimeType: redactAnalysisText(artifact.mimeType || "", 80),
      sizeBytes: safeNumber(artifact.sizeBytes, 0),
      createdAt: artifact.createdAt || "",
      deepLink: artifact.deepLink || "",
      metadata: safeArtifactMetadata(artifact.metadata)
    }))
    .slice(0, 40);
}

function summarizeDiagnostics(diagnostics) {
  if (!diagnostics) return null;
  return {
    status: diagnostics.status || "",
    headline: redactAnalysisText(diagnostics.headline || "", 240),
    reason: redactAnalysisText(diagnostics.reason || "", 500),
    failedStep: redactAnalysisText(diagnostics.failedStep || "", 160),
    failureType: redactAnalysisText(diagnostics.failureType || "", 160),
    failedAt: diagnostics.failedAt || "",
    cancelledBy: redactAnalysisText(diagnostics.cancelledBy || "", 120),
    approval: diagnostics.approval
      ? {
          status: diagnostics.approval.status || "",
          decision: diagnostics.approval.decision || "",
          title: redactAnalysisText(diagnostics.approval.title || "", 200),
          comment: redactAnalysisText(diagnostics.approval.comment || "", 240),
          requestedBy: redactAnalysisText(diagnostics.approval.requestedBy || "", 120)
        }
      : null,
    timeline: (diagnostics.timeline || []).slice(-12).map((event) => ({
      type: redactAnalysisText(event.type || "", 120),
      message: redactAnalysisText(event.message || "", 220),
      createdAt: event.createdAt || ""
    })),
    logExcerpts: (diagnostics.logExcerpts || []).slice(-8).map((event) => ({
      type: redactAnalysisText(event.type || "", 120),
      message: redactAnalysisText(event.message || "", 260),
      createdAt: event.createdAt || ""
    }))
  };
}

function topEventTypes(logSummary = {}) {
  return (logSummary.types || []).slice(0, 20).map((entry) => ({
    key: redactAnalysisText(entry.key || "", 120),
    count: safeNumber(entry.count, 0),
    category: redactAnalysisText(entry.category || "", 80)
  }));
}

function highlightEvents(logSummary = {}) {
  return (logSummary.highlights || []).slice(-20).map((event) => ({
    type: redactAnalysisText(event.type || "", 120),
    category: redactAnalysisText(event.category || "", 80),
    severity: redactAnalysisText(event.severity || "", 40),
    node: redactAnalysisText(event.node || "", 80),
    message: redactAnalysisText(event.message || "", 260),
    createdAt: event.createdAt || ""
  }));
}

function countTextMatches(items, re) {
  return items.reduce((count, item) => count + (re.test(`${item.type || ""} ${item.message || ""}`) ? 1 : 0), 0);
}

function timingSignals(timing) {
  const signals = [];
  if (safeNumber(timing.queuedMs, 0) > 5 * 60_000) signals.push("queued_over_5m");
  if (safeNumber(timing.executionMs, 0) > 20 * 60_000) signals.push("execution_over_20m");
  if (safeNumber(timing.totalMs, 0) > 30 * 60_000) signals.push("total_over_30m");
  return signals;
}

function computeDetectedSignals({ run, timing, logSummary, highlights, inventory, diagnostics, outputShape }) {
  const totals = logSummary.totals || {};
  const retrySignals = countTextMatches(highlights, /\b(retry|retrying|retried|again|backoff|rerun)\b/i);
  const fallbackSignals = countTextMatches(highlights, /\b(fallback|workaround|degraded|skipped|manual)\b/i);
  const approvalSignals = (logSummary.categories || []).find((entry) => entry.key === "approval")?.count || 0;
  const longTimingSignals = timingSignals(timing);
  const artifactCount = inventory.length;
  const hasOutput = outputShape?.type && outputShape.type !== "null";
  const noWorkflowArtifacts = artifactCount === 0;
  const noStructuredOutput = !hasOutput;
  const status = run?.status || "";
  return {
    terminalStatus: TERMINAL_STATUSES.has(status),
    unsuccessfulTerminalStatus: status && status !== "succeeded",
    errorEvents: safeNumber(totals.errors, 0),
    warningEvents: safeNumber(totals.warnings, 0),
    retrySignals,
    fallbackSignals,
    approvalEvents: safeNumber(approvalSignals, 0),
    longTimingSignals,
    artifactOutputGaps: {
      noWorkflowArtifacts,
      noStructuredOutput
    },
    failedStepPresent: Boolean(diagnostics?.failedStep),
    successfulButPainful:
      status === "succeeded"
      && (safeNumber(totals.errors, 0) > 0
        || safeNumber(totals.warnings, 0) > 0
        || retrySignals > 0
        || fallbackSignals > 0
        || longTimingSignals.length > 0
        || (noWorkflowArtifacts && noStructuredOutput))
  };
}

function evidenceQuality(signals, logSummary = {}) {
  if (!signals.terminalStatus) return "none";
  let score = 0;
  if (signals.unsuccessfulTerminalStatus) score += 2;
  if (signals.errorEvents > 0) score += 2;
  if (signals.warningEvents > 0) score += 1;
  if (signals.retrySignals > 0 || signals.fallbackSignals > 0) score += 1;
  if (signals.approvalEvents > 0) score += 1;
  if (signals.longTimingSignals.length > 0) score += 1;
  if (signals.failedStepPresent) score += 1;
  if (signals.artifactOutputGaps.noWorkflowArtifacts || signals.artifactOutputGaps.noStructuredOutput) score += 1;
  if (safeNumber(logSummary.totals?.events, 0) > 20) score += 1;
  if (score >= 5) return "rich";
  if (score >= 3) return "moderate";
  if (score >= 1) return "thin";
  return "none";
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
  const highlights = highlightEvents(logSummary);
  const outputShape = valueShape(run?.output);
  const diagnosticSummary = summarizeDiagnostics(diagnostics);
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
      topEventTypes: topEventTypes(logSummary),
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

function payloadForBudget(payload, maxChars) {
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

export function buildRunObstructionAnalysisRequest(input = {}, options = {}) {
  const maxChars = safeNumber(options.maxPromptChars, DEFAULT_PROMPT_MAX_CHARS);
  const payload = buildRunObstructionAnalysisPayload(input);
  if (!hasEnoughEvidenceForObstructionAnalysis(payload)) return null;
  const budgeted = payloadForBudget(payload, maxChars);
  const userPrompt = `Analyze this redacted RunYard terminal run evidence and return JSON with these fields:
severity, confidence, summary, observations, obstructions, suggestedWorkflowImprovements,
suggestedAgentImprovements, suggestedSkillOrKnowledgeImprovements, followUpQuestions, doNotAutoMutate.
Each observation and obstruction should include evidence and inference. Evidence JSON:
${budgeted.json}`;
  return {
    payload: budgeted.payload,
    promptPayload: budgeted.json,
    promptPayloadTruncated: budgeted.truncated,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ]
  };
}

function parseBool(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function defaultProviderConfig(config = {}) {
  const apiKey = config.obstructionAnalysisApiKey || process.env.SMITHERS_OBSTRUCTION_ANALYSIS_API_KEY || process.env.OPENAI_API_KEY || "";
  const explicitUrl = config.obstructionAnalysisUrl || process.env.SMITHERS_OBSTRUCTION_ANALYSIS_URL || "";
  return {
    enabled: config.obstructionAnalysisEnabled ?? parseBool(process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED, true),
    apiKey,
    url: explicitUrl || (apiKey ? "https://api.openai.com/v1/chat/completions" : ""),
    model: config.obstructionAnalysisModel || process.env.SMITHERS_OBSTRUCTION_ANALYSIS_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    timeoutMs: safeNumber(config.obstructionAnalysisTimeoutMs || process.env.SMITHERS_OBSTRUCTION_ANALYSIS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

export function obstructionAnalyzerConfigured(config = {}) {
  if (injectedAnalyzer) return true;
  const provider = defaultProviderConfig(config);
  return Boolean(provider.enabled && provider.url && provider.apiKey && provider.model);
}

export function setRunObstructionAnalyzerForTest(analyzer) {
  injectedAnalyzer = typeof analyzer === "function" ? analyzer : null;
}

async function openAiCompatibleAnalyzer(request, config = {}) {
  const provider = defaultProviderConfig(config);
  if (!provider.enabled || !provider.url || !provider.apiKey || !provider.model) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        messages: request.messages,
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`obstruction analysis LLM request failed (${response.status}): ${redactAnalysisText(text, 240)}`);
    }
    const data = await response.json();
    const content =
      data?.choices?.[0]?.message?.content
      || data?.output_text
      || data?.output?.[0]?.content?.[0]?.text
      || "";
    if (!content) throw new Error("obstruction analysis LLM response did not include content");
    return { provider: "openai-compatible", model: provider.model, analysis: content };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function allowed(value, allowedValues, fallback) {
  const normalized = String(value || "").toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function confidenceCapForEvidence(quality) {
  if (quality === "rich") return "high";
  if (quality === "moderate") return "medium";
  return "low";
}

function capConfidence(confidence, quality) {
  const level = allowed(confidence, CONFIDENCE_LEVELS, confidenceCapForEvidence(quality));
  const maxIndex = CONFIDENCE_LEVELS.indexOf(confidenceCapForEvidence(quality));
  const levelIndex = CONFIDENCE_LEVELS.indexOf(level);
  return CONFIDENCE_LEVELS[Math.min(levelIndex, maxIndex)];
}

function normalizeEvidenceInferenceEntry(entry, payload, fallbackSeverity = "low") {
  if (typeof entry === "string") {
    return {
      evidence: "",
      inference: redactAnalysisText(entry, 500),
      severity: fallbackSeverity,
      confidence: confidenceCapForEvidence(payload.evidence?.quality)
    };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return {
    category: entry.category ? redactAnalysisText(entry.category, 120) : undefined,
    evidence: redactAnalysisText(entry.evidence || "", 700),
    inference: redactAnalysisText(entry.inference || entry.summary || entry.impact || "", 700),
    impact: entry.impact ? redactAnalysisText(entry.impact, 500) : undefined,
    severity: allowed(entry.severity, OBSTRUCTION_SEVERITIES, fallbackSeverity),
    confidence: capConfidence(entry.confidence, payload.evidence?.quality)
  };
}

function normalizeStringList(value, maxItems = 10) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .map((item) => (typeof item === "string" ? item : item?.proposal || item?.text || item?.summary || ""))
    .map((item) => redactAnalysisText(item, 500))
    .filter(Boolean)
    .slice(0, maxItems);
}

function fallbackSeverity(payload) {
  const signals = payload.evidence?.detectedSignals || {};
  if (payload.run?.status === "failed") return "high";
  if (payload.run?.status === "cancelled") return "medium";
  if (signals.errorEvents > 0 || (signals.longTimingSignals || []).length > 1) return "medium";
  if (signals.warningEvents > 0 || signals.retrySignals > 0 || signals.fallbackSignals > 0) return "low";
  return "none";
}

function fallbackSummary(payload) {
  const status = payload.run?.status || "unknown";
  const signals = payload.evidence?.detectedSignals || {};
  if (status !== "succeeded") return `Terminal ${status} run has obstruction evidence in status, diagnostics, or events.`;
  if (signals.successfulButPainful) return "Run succeeded, but warnings, retries, fallback behavior, or long timing suggest avoidable friction.";
  return "No clear obstruction evidence was present in the bounded run summary.";
}

function normalizeAnalysis(raw, payload) {
  const object = parseJsonObject(raw);
  const quality = payload.evidence?.quality || "thin";
  const severity = allowed(object.severity, OBSTRUCTION_SEVERITIES, fallbackSeverity(payload));
  const confidence = capConfidence(object.confidence, quality);
  const observations = (Array.isArray(object.observations) ? object.observations : [])
    .map((entry) => normalizeEvidenceInferenceEntry(entry, payload, severity === "none" ? "none" : "low"))
    .filter(Boolean)
    .slice(0, 12);
  const obstructions = (Array.isArray(object.obstructions) ? object.obstructions : [])
    .map((entry) => normalizeEvidenceInferenceEntry(entry, payload, severity))
    .filter(Boolean)
    .slice(0, 12);
  if (!observations.length && severity !== "none") {
    observations.push({
      evidence: JSON.stringify(payload.evidence.detectedSignals),
      inference: fallbackSummary(payload),
      severity,
      confidence
    });
  }
  return {
    severity,
    confidence,
    summary: redactAnalysisText(object.summary || fallbackSummary(payload), 800),
    observations,
    obstructions,
    suggestedWorkflowImprovements: normalizeStringList(object.suggestedWorkflowImprovements),
    suggestedAgentImprovements: normalizeStringList(object.suggestedAgentImprovements),
    suggestedSkillOrKnowledgeImprovements: normalizeStringList(object.suggestedSkillOrKnowledgeImprovements),
    followUpQuestions: normalizeStringList(object.followUpQuestions),
    doNotAutoMutate: true
  };
}

export function buildRunObstructionAnalysisArtifact({ payload, rawAnalysis, analyzer = {}, generatedAt = timestamp(), promptPayloadTruncated = false } = {}) {
  const normalized = normalizeAnalysis(rawAnalysis, payload);
  const content = {
    schemaVersion: RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION,
    generatedAt,
    generatedBy: "runyard",
    purpose: "Best-effort LLM-assisted obstruction analysis for a terminal run.",
    policy: {
      artifactOnly: true,
      autoMutations: false,
      mutatedSoftAssets: [],
      doNotAutoMutate: true
    },
    doNotAutoMutate: true,
    analyzer: {
      type: "llm",
      provider: redactAnalysisText(analyzer.provider || "configured", 120),
      model: redactAnalysisText(analyzer.model || "", 120),
      promptPayloadTruncated: Boolean(promptPayloadTruncated)
    },
    run: payload.run,
    workflow: payload.workflow,
    timing: payload.timing,
    outcome: payload.outcome,
    evidence: payload.evidence,
    severity: normalized.severity,
    confidence: {
      level: normalized.confidence,
      evidenceQuality: payload.evidence?.quality || "thin",
      rationale: "Confidence is capped by the bounded evidence available to the analyzer."
    },
    summary: normalized.summary,
    observations: normalized.observations,
    obstructions: normalized.obstructions,
    suggestedWorkflowImprovements: normalized.suggestedWorkflowImprovements,
    suggestedAgentImprovements: normalized.suggestedAgentImprovements,
    suggestedSkillOrKnowledgeImprovements: normalized.suggestedSkillOrKnowledgeImprovements,
    followUpQuestions: normalized.followUpQuestions,
    notes: [
      "This artifact is generated by the Hub after terminalization.",
      "It uses bounded redacted summaries, not full raw inputs, raw outputs, env files, or artifact contents.",
      "It proposes improvements only; it did not edit workflows, agents, skills, prompts, knowledge, or templates."
    ]
  };
  return {
    name: RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME,
    mimeType: "application/json",
    content: JSON.stringify(content, null, 2),
    metadata: {
      generatedBy: "runyard",
      kind: "run-obstruction-analysis",
      schemaVersion: RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION
    }
  };
}

export async function analyzeRunObstructions(input = {}, options = {}) {
  const request = buildRunObstructionAnalysisRequest(input, {
    maxPromptChars: options.maxPromptChars || options.config?.obstructionAnalysisMaxPromptChars
  });
  if (!request) return null;
  const analyzer = injectedAnalyzer || ((req) => openAiCompatibleAnalyzer(req, options.config || {}));
  const result = await analyzer(request);
  if (!result) return null;
  const rawAnalysis = Object.hasOwn(result, "analysis") ? result.analysis : result;
  const analyzerInfo = {
    provider: result.provider || (injectedAnalyzer ? "injected" : "openai-compatible"),
    model: result.model || ""
  };
  return buildRunObstructionAnalysisArtifact({
    payload: request.payload,
    rawAnalysis,
    analyzer: analyzerInfo,
    promptPayloadTruncated: request.promptPayloadTruncated,
    generatedAt: input.generatedAt || timestamp()
  });
}
