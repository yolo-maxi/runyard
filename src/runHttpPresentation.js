import { deepLinks } from "./deepLinks.js";

export function runStatusLinks(runId) {
  return {
    statusUrl: `/api/runs/${runId}`,
    webUrl: `/app#runs/${runId}`,
    deepLink: deepLinks.run(runId)
  };
}

export function runOutputLinks(runId) {
  return {
    ...runStatusLinks(runId),
    logsUrl: `/api/runs/${runId}/logs`,
    artifactsUrl: `/api/runs/${runId}/artifacts`,
    outputsLocation: "hub",
    artifactsLocation: "hub",
    deepLinkLogs: deepLinks.runLogs(runId),
    deepLinkArtifacts: deepLinks.runArtifacts(runId)
  };
}
