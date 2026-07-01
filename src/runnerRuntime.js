import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveImproveRepo } from "../workflow-templates/workflows/improve-repo.js";

export function isSupervisorCapability(capability) {
  return capability?.slug === "run-smithers";
}

export function activeRunnerLoad(activeRunKinds = new Map()) {
  let work = 0;
  let supervisors = 0;
  for (const kind of activeRunKinds.values()) {
    if (kind === "supervisor") supervisors += 1;
    else work += 1;
  }
  return { work, supervisors };
}

export function supervisorConcurrencyLimit(concurrency, ratio = 1) {
  return Math.max(1, Math.ceil(concurrency * Number(ratio || 1)));
}

export function hasClaimCapacity(activeRunKinds, concurrency, ratio = 1) {
  const load = activeRunnerLoad(activeRunKinds);
  return load.work < concurrency || load.supervisors < supervisorConcurrencyLimit(concurrency, ratio);
}

export function authOkFor(capability, health = {}) {
  const agents = Array.isArray(capability?.requiredAgents) ? capability.requiredAgents : [];
  const text = `${capability?.slug || ""} ${agents.join(" ")} ${JSON.stringify(capability?.workflow || {})}`.toLowerCase();
  const needsClaude = /claude|implementation-agent|researcher|product-manager|taste-agent|design-director|run-knowledge-analyst|smithers-watcher/.test(text);
  const needsCodex = /codex/.test(text);
  const missing = [];
  if (needsClaude && health?.claude?.ok === false) missing.push(`claude: ${health.claude.error || "not authenticated"}`);
  if (needsCodex && health?.codex?.ok === false) missing.push(`codex: ${health.codex.error || "not authenticated"}`);
  return missing;
}

export function preflightImproveRepo(run, capability, { workspace, env = process.env, gitBin = "git", gitEnv = env } = {}) {
  if (capability?.slug !== "improve") return [];
  try {
    resolveImproveRepo(run?.input || {}, {
      env,
      cwd: workspace,
      gitBin,
      gitEnv
    });
    return [];
  } catch (error) {
    return [`improve repo preflight failed: ${error.message || error}`];
  }
}

export function preflightAssignment(run, capability, entry, { workspace, health, env = process.env, gitBin = "git", gitEnv = env } = {}) {
  if (!entry) return [`capability ${capability?.slug || "unknown"} has no workflow.entry`];
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const failures = [];
  if (!existsSync(workflowPath)) failures.push(`workflow file not found: ${workflowPath}`);
  failures.push(...preflightImproveRepo(run, capability, { workspace, env, gitBin, gitEnv }));
  failures.push(...authOkFor(capability, health));
  return failures;
}

export function materializeAgentRuntimePack(run, pack, { workspace } = {}) {
  if (!pack || typeof pack !== "object") return {};
  const runtimeDir = path.join(workspace, ".smithers", "runtime-packs");
  mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, `${run.id}.agent-runtime.json`);
  writeFileSync(file, JSON.stringify(pack, null, 2), { mode: 0o600 });
  return {
    RUNYARD_AGENT_RUNTIME_PACK_FILE: file,
    RUNYARD_AGENT_RUNTIME_PACK: JSON.stringify({
      schemaVersion: pack.schemaVersion,
      capturedAt: pack.capturedAt,
      capability: pack.capability,
      agents: (pack.agents || []).map((agent) => ({ slug: agent.slug, version: agent.version })),
      skills: (pack.skills || []).map((skill) => ({ slug: skill.slug, version: skill.version }))
    })
  };
}
