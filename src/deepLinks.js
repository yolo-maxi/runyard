export const deepLinks = {
  run: (id) => `/app#runs/${encodeURIComponent(id)}`,
  runLogs: (id) => `/app#runs/${encodeURIComponent(id)}/logs`,
  runArtifacts: (id) => `/app#runs/${encodeURIComponent(id)}/artifacts`,
  workflow: (slug) => `/app#workflows/${encodeURIComponent(slug)}`,
  workflowRuns: (slug) => `/app#workflows/${encodeURIComponent(slug)}/runs`,
  workflowEdit: (slug) => `/app#workflows/${encodeURIComponent(slug)}/edit`,
  workflowRun: (slug) => `/app#workflows/${encodeURIComponent(slug)}/run`,
  agent: (slug) => `/app#agents/agents/${encodeURIComponent(slug)}`,
  artifact: (artifact) => {
    const id = typeof artifact === "object" ? artifact.id : artifact;
    const runId = typeof artifact === "object" ? artifact.runId : "";
    return runId
      ? `/app#runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`
      : "/app#runs";
  },
  approval: (id) => `/app#approvals/${encodeURIComponent(id)}`,
  work: () => "/app#work",
  workItem: (id) => `/app#work/${encodeURIComponent(id)}`,
  workItemFlow: (id) => `/app#work/${encodeURIComponent(id)}/flow`
};

export function absoluteDeepLink(link, baseUrl) {
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return `${String(baseUrl || "").replace(/\/$/, "")}${link}`;
  }
}

export function withCapabilityLinks(capability) {
  if (!capability || typeof capability !== "object") return capability;
  return {
    ...capability,
    deepLink: deepLinks.workflow(capability.slug),
    deepLinkRuns: deepLinks.workflowRuns(capability.slug),
    deepLinkEdit: deepLinks.workflowEdit(capability.slug),
    deepLinkRun: deepLinks.workflowRun(capability.slug)
  };
}

export function withAgentLinks(agent) {
  if (!agent || typeof agent !== "object") return agent;
  return { ...agent, deepLink: deepLinks.agent(agent.slug) };
}

export function withArtifactLinks(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  return {
    ...artifact,
    deepLink: deepLinks.artifact(artifact),
    deepLinkRun: deepLinks.run(artifact.runId)
  };
}
