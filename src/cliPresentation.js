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
