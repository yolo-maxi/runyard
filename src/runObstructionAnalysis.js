import { safeNumber, timestamp } from "./runEvidence.js";
import { parseBool } from "./configParsing.js";
import {
  buildRunObstructionAnalysisPayload,
  hasEnoughEvidenceForObstructionAnalysis,
  payloadForBudget,
  redactAnalysisText,
  RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION
} from "./runObstructionPayload.js";
import { normalizeAnalysis } from "./runObstructionAnalysisNormalization.js";

export const RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME = "run-obstruction-analysis.json";
export {
  buildRunObstructionAnalysisPayload,
  hasEnoughEvidenceForObstructionAnalysis,
  redactAnalysisText,
  RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION
} from "./runObstructionPayload.js";

const DEFAULT_PROMPT_MAX_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You analyze terminal agent workflow runs for obstructions.
Return only valid JSON. Separate evidence from inference. Be conservative when evidence is thin.
Look for blockers, failed steps, missing context, unclear goals, tool/path/env/runner issues,
approval friction, retries, repeated errors, fallback behavior, long queue/execution/total time,
human corrections, workflow/agent/skill design issues, artifact/output gaps, and successful but
painful runs. Recommendations are proposals only. Do not suggest or perform automatic mutation.`;

let injectedAnalyzer = null;

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

export function buildRunObstructionAnalysisArtifact({ payload, rawAnalysis, analyzer = {}, generatedAt = timestamp(), promptPayloadTruncated = false } = {}) {
  const normalized = normalizeAnalysis(rawAnalysis, payload, { redactText: redactAnalysisText });
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
