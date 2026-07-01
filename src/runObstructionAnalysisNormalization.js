export const OBSTRUCTION_SEVERITIES = ["none", "low", "medium", "high"];
export const CONFIDENCE_LEVELS = ["low", "medium", "high"];

export function parseJsonObject(value) {
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

export function allowed(value, allowedValues, fallback) {
  const normalized = String(value || "").toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

export function confidenceCapForEvidence(quality) {
  if (quality === "rich") return "high";
  if (quality === "moderate") return "medium";
  return "low";
}

export function capConfidence(confidence, quality) {
  const level = allowed(confidence, CONFIDENCE_LEVELS, confidenceCapForEvidence(quality));
  const maxIndex = CONFIDENCE_LEVELS.indexOf(confidenceCapForEvidence(quality));
  const levelIndex = CONFIDENCE_LEVELS.indexOf(level);
  return CONFIDENCE_LEVELS[Math.min(levelIndex, maxIndex)];
}

export function normalizeEvidenceInferenceEntry(entry, payload, { redactText, fallbackSeverity = "low" } = {}) {
  if (typeof entry === "string") {
    return {
      evidence: "",
      inference: redactText(entry, 500),
      severity: fallbackSeverity,
      confidence: confidenceCapForEvidence(payload.evidence?.quality)
    };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return {
    category: entry.category ? redactText(entry.category, 120) : undefined,
    evidence: redactText(entry.evidence || "", 700),
    inference: redactText(entry.inference || entry.summary || entry.impact || "", 700),
    impact: entry.impact ? redactText(entry.impact, 500) : undefined,
    severity: allowed(entry.severity, OBSTRUCTION_SEVERITIES, fallbackSeverity),
    confidence: capConfidence(entry.confidence, payload.evidence?.quality)
  };
}

export function normalizeStringList(value, { redactText, maxItems = 10 } = {}) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .map((item) => (typeof item === "string" ? item : item?.proposal || item?.text || item?.summary || ""))
    .map((item) => redactText(item, 500))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function fallbackSeverity(payload) {
  const signals = payload.evidence?.detectedSignals || {};
  if (payload.run?.status === "failed") return "high";
  if (payload.run?.status === "cancelled") return "medium";
  if (signals.errorEvents > 0 || (signals.longTimingSignals || []).length > 1) return "medium";
  if (signals.warningEvents > 0 || signals.retrySignals > 0 || signals.fallbackSignals > 0) return "low";
  return "none";
}

export function fallbackSummary(payload) {
  const status = payload.run?.status || "unknown";
  const signals = payload.evidence?.detectedSignals || {};
  if (status !== "succeeded") return `Terminal ${status} run has obstruction evidence in status, diagnostics, or events.`;
  if (signals.successfulButPainful) return "Run succeeded, but warnings, retries, fallback behavior, or long timing suggest avoidable friction.";
  return "No clear obstruction evidence was present in the bounded run summary.";
}

export function normalizeAnalysis(raw, payload, { redactText } = {}) {
  const object = parseJsonObject(raw);
  const quality = payload.evidence?.quality || "thin";
  const severity = allowed(object.severity, OBSTRUCTION_SEVERITIES, fallbackSeverity(payload));
  const confidence = capConfidence(object.confidence, quality);
  const observations = (Array.isArray(object.observations) ? object.observations : [])
    .map((entry) => normalizeEvidenceInferenceEntry(entry, payload, { redactText, fallbackSeverity: severity === "none" ? "none" : "low" }))
    .filter(Boolean)
    .slice(0, 12);
  const obstructions = (Array.isArray(object.obstructions) ? object.obstructions : [])
    .map((entry) => normalizeEvidenceInferenceEntry(entry, payload, { redactText, fallbackSeverity: severity }))
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
    summary: redactText(object.summary || fallbackSummary(payload), 800),
    observations,
    obstructions,
    suggestedWorkflowImprovements: normalizeStringList(object.suggestedWorkflowImprovements, { redactText }),
    suggestedAgentImprovements: normalizeStringList(object.suggestedAgentImprovements, { redactText }),
    suggestedSkillOrKnowledgeImprovements: normalizeStringList(object.suggestedSkillOrKnowledgeImprovements, { redactText }),
    followUpQuestions: normalizeStringList(object.followUpQuestions, { redactText }),
    doNotAutoMutate: true
  };
}
