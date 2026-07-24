export function renderData(data, { json = false } = {}) {
  if (json) return [JSON.stringify(data, null, 2)];
  if (!Array.isArray(data)) return [JSON.stringify(data, null, 2)];
  return data.map((item) => `${item.id || item.slug}\t${item.name || item.title || item.status || ""}\t${item.description || item.currentStep || ""}`);
}

export function renderMenu(data, { json = false, all = false } = {}) {
  if (json) return renderData(data, { json: true });
  const lines = ["Try: runyard run hello"];
  const caps = data.capabilities || [];
  const shown = all ? caps : caps.slice(0, 5);
  if (shown.length) {
    lines.push("", "Workflows:");
    shown.forEach((cap, index) => lines.push(`  ${index + 1}. ${cap.slug}\t${cap.name}`));
    if (!all && caps.length > shown.length) {
      lines.push(`  …${caps.length - shown.length} more — run \`runyard menu --all\` for the full catalog`);
    }
  }
  if (data.runInputGuidance?.title) lines.push("", `Run input: ${data.runInputGuidance.title}`);
  lines.push("", "After a run: runyard run-status|logs|artifacts <run-id>");
  return lines;
}

// Human-readable negotiation report for `runyard preflight` and
// `runyard run --negotiate`. `data` is either { negotiation, draft? } (from
// preflight / a non-ready negotiate create) or a 202 body carrying negotiation.
export function renderNegotiation(data) {
  const negotiation = data.negotiation || data;
  const lines = [`Preflight: ${negotiation.status}${negotiation.capability ? ` (${negotiation.capability})` : ""}`];
  for (const question of negotiation.questions || []) {
    lines.push(`  needs input: ${question.field} — ${question.question}${question.expected ? ` [${question.expected}]` : ""}`);
  }
  for (const blocker of negotiation.blockers || []) {
    lines.push(`  blocked: ${blocker.code} — ${blocker.message}`);
  }
  for (const warning of negotiation.warnings || []) {
    lines.push(`  warning: ${warning.code} — ${warning.message}`);
  }
  for (const [field, value] of Object.entries(negotiation.suggestedDefaults || {})) {
    lines.push(`  suggested ${field}: ${value}`);
  }
  if (data.draft?.id) {
    lines.push(`Draft saved: ${data.draft.id} (PATCH /api/run-drafts/${data.draft.id}, then POST /api/run-drafts/${data.draft.id}/submit)`);
  }
  if (negotiation.nextAction) lines.push(`Next: ${negotiation.nextAction}`);
  return lines;
}

export function renderRunCreated(data) {
  const run = data.run || data;
  const execution = run.execution || {};
  const lines = [
    `Run ${run.id} queued for ${run.capabilityName || run.capabilitySlug}.`,
    `Execution: ${execution.mode || "auto"}${execution.runnerLocation ? ` (${execution.runnerLocation})` : ""}`,
    `Hub status: runyard run-status ${run.id}`,
    `Hub logs: runyard logs ${run.id}`,
    `Hub artifacts and outputs: runyard artifacts ${run.id}`
  ];
  const improveRepoSelector = run.input?.repoDir || run.input?.repo || run.input?.project || "";
  if (run.capabilitySlug === "improve" && improveRepoSelector) {
    lines.push(`Edited repo requested on runner: ${improveRepoSelector}`);
  }
  return lines;
}

// --- CI (repositories + pipelines; specs/ci-platform.md) --------------------

export function renderCiRepoList(data) {
  const repos = data.repos || [];
  const installations = data.installations || [];
  if (!repos.length) {
    return [
      "No CI-connected repositories.",
      installations.length
        ? `Installations present (${installations.length}) — run \`runyard repo sync\` to pull their repositories.`
        : "Install the GitHub App on a repository, then run `runyard repo sync`."
    ];
  }
  const lines = [];
  for (const repo of repos) {
    const trust = repo.trustPolicy || {};
    lines.push(
      `${repo.fullName}\t${repo.enabled ? "enabled" : "disabled"}\t${trust.level || "untrusted"}${trust.allowNative ? "+native" : ""}\tdefault: ${repo.defaultBranch}\tid: ${repo.id}`
    );
  }
  return lines;
}

export function renderCiPipeline(data) {
  const pipeline = data.pipeline || data;
  const trigger = pipeline.trigger || {};
  const runStatus = pipeline.run?.status || "(no run)";
  const lines = [
    `Pipeline ${pipeline.id} — ${runStatus}${pipeline.supersededBy ? ` (superseded by ${pipeline.supersededBy})` : ""}`,
    `Trigger: ${trigger.event || "?"}${trigger.prNumber ? ` PR #${trigger.prNumber}` : ""}${trigger.ref ? ` ${trigger.ref}` : ""} @ ${(trigger.headSha || "").slice(0, 12)}`,
    `Config: ${pipeline.configSource?.path || ".runyard/ci.yml"} @ ${(pipeline.configSource?.sha || "").slice(0, 12)}  tested: ${pipeline.tested?.strategy || "?"}`
  ];
  for (const job of pipeline.jobs || []) {
    const state = job.run ? job.run.status : job.phase;
    const check = job.checkState ? `  check: ${job.checkState}` : "";
    lines.push(`  ${job.jobName}\t${state}${job.phaseReason ? ` (${job.phaseReason})` : ""}${job.run ? `  run: ${job.run.id}` : ""}${check}`);
  }
  if (pipeline.run?.deepLink) lines.push(`Run detail: ${pipeline.run.deepLink}`);
  return lines;
}
