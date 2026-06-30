import { RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME } from "./runObstructionAnalysis.js";
import { RUN_RETROSPECTIVE_ARTIFACT_NAME } from "./runRetrospective.js";

export function artifactTimelineKind(artifact = {}) {
  const metaKind = artifact.metadata && typeof artifact.metadata === "object" ? artifact.metadata.kind || "" : "";
  if (artifact.name === RUN_RETROSPECTIVE_ARTIFACT_NAME || metaKind === "run-retrospective") {
    return { kind: "retrospective", source: "artifacts:retrospective" };
  }
  if (artifact.name === RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME || metaKind === "run-obstruction-analysis") {
    return { kind: "obstruction", source: "artifacts:obstruction" };
  }
  return { kind: "artifact", source: "artifacts:runner" };
}

export function buildRunTimeline(run, { events = [], artifacts = [], withArtifactLinks = (artifact) => artifact } = {}) {
  const entries = [];
  const transitions = [
    ["created", run.createdAt, "queued"],
    ["assigned", run.assignedAt, "assigned"],
    ["started", run.startedAt, "running"],
    ["completed", run.completedAt, run.status]
  ];
  for (const [transition, ts, status] of transitions) {
    if (!ts) continue;
    entries.push({
      ts,
      kind: "status",
      source: "runs",
      payload: {
        runId: run.id,
        transition,
        status,
        currentStep: run.currentStep || null,
        ...(transition === "completed" && run.error ? { error: run.error } : {})
      }
    });
  }
  for (const event of events) {
    entries.push({
      ts: event.createdAt,
      kind: "event",
      source: "run_events",
      payload: {
        id: event.id,
        type: event.type,
        message: event.message,
        data: event.data
      }
    });
  }
  for (const artifact of artifacts) {
    const linked = withArtifactLinks(artifact);
    const { kind, source } = artifactTimelineKind(artifact);
    entries.push({
      ts: artifact.createdAt,
      kind,
      source,
      payload: {
        id: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        metadata: artifact.metadata || {},
        deepLink: linked.deepLink || null,
        deepLinkRun: linked.deepLinkRun || null
      }
    });
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

export function timelinePage(entries = [], { since = "", limit = 200 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number.isFinite(limit) && limit > 0 ? limit : 200, 1000));
  const filtered = since ? entries.filter((entry) => entry.ts > since) : entries;
  let slice = filtered.slice(0, normalizedLimit);
  let truncated = filtered.length > slice.length;

  if (truncated && slice.length) {
    const lastTs = slice[slice.length - 1].ts;
    if (filtered[slice.length] && filtered[slice.length].ts === lastTs) {
      let trim = slice.length;
      while (trim > 0 && slice[trim - 1].ts === lastTs) trim -= 1;
      if (trim > 0) {
        slice = slice.slice(0, trim);
      } else {
        let extend = slice.length;
        while (filtered[extend] && filtered[extend].ts === lastTs) extend += 1;
        slice = filtered.slice(0, extend);
        truncated = filtered.length > slice.length;
      }
    }
  }

  return {
    entries: slice,
    limit: normalizedLimit,
    since: since || null,
    nextSince: slice.length ? slice[slice.length - 1].ts : since || null,
    truncated
  };
}
