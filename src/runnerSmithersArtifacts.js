import { markdownArtifactsFromOutputs } from "./runnerArtifacts.js";
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

export function smithersArtifactPayloads({ sid, state, outputs = {}, eventLines = [] }) {
  return [
    {
      name: "smithers-output.json",
      mimeType: "application/json",
      content: JSON.stringify({ smithersRunId: sid, state, outputs }, null, 2)
    },
    ...markdownArtifactsFromOutputs(outputs),
    {
      name: "smithers-events.ndjson",
      mimeType: "application/x-ndjson",
      content: smithersEventsArtifactContent(eventLines)
    }
  ];
}
