import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workflowBundleSha256 } from "./workflowBundleRecords.js";
import { workflowBundleReference } from "./workflowSource.js";
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

// A capability with workflow.bundleId executes DB-published source, not a
// checked-in template. The Hub ships the bundle bytes inside the claim payload;
// this writes them to an isolated per-run file (the stored capability record is
// never mutated) and verifies the sha256 recorded at publish time before
// Smithers ever sees the file. Any gap — bundle data absent from the payload,
// bundle id mismatch, digest mismatch, write failure — throws so the caller
// fails the run closed instead of falling back to a template file. Returns
// null for file-backed capabilities so their behavior is untouched.
export function materializeWorkflowBundle(run, capability, bundle, { workspace } = {}) {
  const bundleId = workflowBundleReference(capability);
  if (!bundleId) return null;
  const slug = capability?.slug || "unknown";
  if (!bundle || typeof bundle.code !== "string") {
    throw new Error(
      `capability ${slug} references workflow bundle ${bundleId}, but the claim payload carried no bundle code; refusing to fall back to a workflow template`
    );
  }
  if (bundle.id && bundle.id !== bundleId) {
    throw new Error(`claim payload carried workflow bundle ${bundle.id}, but capability ${slug} references ${bundleId}`);
  }
  const sha256 = workflowBundleSha256(bundle.code);
  if (sha256 !== bundle.sha256) {
    throw new Error(`workflow bundle ${bundleId} sha256 mismatch: stored ${bundle.sha256 || "(none)"}, materialized ${sha256}`);
  }
  const language = /^[a-z0-9]{1,10}$/.test(String(bundle.language || "")) ? bundle.language : "tsx";
  const bundleDir = path.join(workspace, ".smithers", "workflow-bundles", String(run.id));
  mkdirSync(bundleDir, { recursive: true });
  const entry = path.join(bundleDir, `${bundleId}.v${bundle.version || 0}.${language}`);
  writeFileSync(entry, bundle.code, { mode: 0o600 });
  return {
    entry,
    bundleId,
    version: bundle.version ?? null,
    sha256,
    sizeBytes: Buffer.byteLength(bundle.code, "utf8")
  };
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
