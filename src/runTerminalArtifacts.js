import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { now, slugify } from "./ids.js";
import { buildRunRetrospectiveArtifact, RUN_RETROSPECTIVE_ARTIFACT_NAME } from "./runRetrospective.js";
import {
  analyzeRunObstructions,
  obstructionAnalyzerConfigured,
  redactAnalysisText,
  RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME
} from "./runObstructionAnalysis.js";

export function hasRunObstructionAnalysisArtifact(artifacts = []) {
  return artifacts.some(
    (artifact) =>
      artifact.name === RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME
      || artifact.metadata?.kind === "run-obstruction-analysis"
  );
}

export function createRunTerminalArtifactService({
  env,
  createArtifact,
  getRun,
  listArtifacts,
  listRunEvents,
  getCapability,
  withArtifactLinks,
  withRunLinks,
  withCapabilityLinks,
  summarizeRunEvents,
  runDiagnostics,
  scrubStoredSecrets,
  addRunEvent,
  scheduleRunResponseEndpointDelivery,
  reconcileRepairChildTerminal,
  reapStuckRunIds,
  scheduleImmediate = setImmediate
}) {
  const pendingObstructionAnalyses = new Set();

  function storeRunArtifact(runRecord, body = {}) {
    const workflowSlug = slugify(runRecord.capabilitySlug || runRecord.capabilityName || "workflow") || "workflow";
    const runDate = String(runRecord.createdAt || now()).slice(0, 10) || "unknown-date";
    const runDir = path.join(env.artifactDir, "runs", workflowSlug, runDate, runRecord.id);
    mkdirSync(runDir, { recursive: true });
    const safeName = String(body.name || "artifact.txt")
      .replace(/[/\\]/g, "-")
      .replace(/[\0\r\n]/g, "")
      .trim() || "artifact.txt";
    const filePath = path.join(runDir, safeName);
    const content = body.contentBase64
      ? Buffer.from(body.contentBase64, "base64")
      : Buffer.from(String(scrubStoredSecrets(String(body.content ?? ""))));
    writeFileSync(filePath, content);
    const stats = statSync(filePath);
    return createArtifact({
      runId: runRecord.id,
      name: safeName,
      mimeType: body.mimeType || "application/octet-stream",
      sizeBytes: stats.size,
      path: filePath,
      metadata: body.metadata || {}
    });
  }

  function artifactContext(runId) {
    const run = getRun(runId);
    if (!run) return null;
    const artifacts = listArtifacts({ runId });
    const events = listRunEvents(runId);
    const capability = getCapability(run.capabilitySlug);
    return {
      run,
      artifacts,
      artifactInput: {
        run: withRunLinks(run),
        capability: capability ? withCapabilityLinks(capability) : null,
        artifacts: artifacts.map(withArtifactLinks),
        logSummary: summarizeRunEvents(events),
        diagnostics: runDiagnostics(run, events, artifacts),
        generatedAt: now()
      }
    };
  }

  function ensureRunRetrospectiveArtifact(runId) {
    const context = artifactContext(runId);
    if (!context) return null;
    if (context.artifacts.some((artifact) => artifact.name === RUN_RETROSPECTIVE_ARTIFACT_NAME || artifact.metadata?.kind === "run-retrospective")) {
      return null;
    }
    return storeRunArtifact(context.run, buildRunRetrospectiveArtifact(context.artifactInput));
  }

  async function ensureRunObstructionAnalysisArtifact(runId) {
    if (!obstructionAnalyzerConfigured(env)) return null;
    const context = artifactContext(runId);
    if (!context || !["succeeded", "failed", "cancelled"].includes(context.run.status)) return null;
    if (hasRunObstructionAnalysisArtifact(context.artifacts)) return null;
    const artifact = await analyzeRunObstructions(context.artifactInput, { config: env });
    if (!artifact) return null;
    if (hasRunObstructionAnalysisArtifact(listArtifacts({ runId }))) return null;
    return storeRunArtifact(context.run, artifact);
  }

  function recordRunRetrospectiveArtifact(runId) {
    try {
      return ensureRunRetrospectiveArtifact(runId);
    } catch (error) {
      console.error(`Run retrospective artifact failed for ${runId}:`, error.message);
      addRunEvent(runId, "run.retrospective_failed", "Run retrospective artifact generation failed", {
        error: String(error.message || error).slice(0, 500)
      });
      return null;
    }
  }

  async function recordRunObstructionAnalysisArtifact(runId) {
    try {
      return await ensureRunObstructionAnalysisArtifact(runId);
    } catch (error) {
      console.error(`Run obstruction analysis artifact failed for ${runId}:`, redactAnalysisText(error.message || error, 500));
      addRunEvent(runId, "run.obstruction_analysis_failed", "Run obstruction analysis artifact generation failed", {
        error: redactAnalysisText(error.message || error, 500)
      });
      return null;
    }
  }

  function scheduleRunObstructionAnalysisArtifact(runId) {
    if (!runId || pendingObstructionAnalyses.has(runId) || !obstructionAnalyzerConfigured(env)) return;
    pendingObstructionAnalyses.add(runId);
    scheduleImmediate(() => {
      recordRunObstructionAnalysisArtifact(runId).finally(() => {
        pendingObstructionAnalyses.delete(runId);
      });
    });
  }

  function dispatchRunResponseEndpointDelivery(runId) {
    if (!runId) return;
    scheduleImmediate(() => {
      scheduleRunResponseEndpointDelivery(runId).catch((error) => {
        console.error(`Run response endpoint delivery failed for ${runId}:`, error?.message || error);
      });
    });
  }

  function recordRunTerminalArtifacts(runId) {
    const retrospective = recordRunRetrospectiveArtifact(runId);
    scheduleRunObstructionAnalysisArtifact(runId);
    dispatchRunResponseEndpointDelivery(runId);
    try {
      reconcileRepairChildTerminal(runId);
    } catch (error) {
      console.error("repair-child completion hook failed:", error.message);
    }
    return retrospective;
  }

  function reapStuckRunsWithRetrospectives(maxMs) {
    const runIds = reapStuckRunIds(maxMs);
    for (const runId of runIds) recordRunTerminalArtifacts(runId);
    return runIds.length;
  }

  return {
    dispatchRunResponseEndpointDelivery,
    recordRunTerminalArtifacts,
    reapStuckRunsWithRetrospectives,
    storeRunArtifact
  };
}
