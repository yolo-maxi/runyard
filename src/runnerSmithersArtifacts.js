import { markdownArtifactsFromOutputs } from "./runnerArtifacts.js";
import { collectChangedFiles } from "./runOutcomePresentation.js";
import { smithersEventsArtifactContent } from "./runnerSmithersEvents.js";

export async function collectSmithersRunResult(sid, { getState, nodeOutput, fetchEvents }) {
  const inspect = await getState(sid);
  const outputs = {};
  for (const step of inspect.steps || []) {
    const output = await nodeOutput(sid, step.id);
    if (output !== null) outputs[step.id] = output;
  }
  return {
    inspect,
    outputs,
    eventLines: await fetchEvents(sid)
  };
}

// Snapshot of the real changed-file evidence the workflow produced, stamped
// into smithers-output.json so the Runs UI (and any external consumer of the
// terminal artifact) can read the count directly without re-deriving it from
// node-specific keys.
export function smithersChangeSummary(outputs = {}) {
  const files = collectChangedFiles({ outputs });
  return { changedFileCount: files.length, files };
}

export function smithersArtifactPayloads({ sid, state, outputs = {}, eventLines = [] }) {
  const changeSummary = smithersChangeSummary(outputs);
  return [
    {
      name: "smithers-output.json",
      mimeType: "application/json",
      content: JSON.stringify({ smithersRunId: sid, state, outputs, changeSummary }, null, 2)
    },
    ...markdownArtifactsFromOutputs(outputs),
    {
      name: "smithers-events.ndjson",
      mimeType: "application/x-ndjson",
      content: smithersEventsArtifactContent(eventLines)
    }
  ];
}
