import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workflowBundleSha256 } from "./workflowBundleRecords.js";
import { workflowBundleReference } from "./workflowSource.js";
import { resolveHarnessSelection } from "./runHarnessSelection.js";
import { lintSmithersWorkflowSource } from "./smithersHardening.js";
import { resolveImproveRepo } from "../workflow-templates/workflows/improve-repo.js";

export function activeRunnerLoad(activeRuns = new Set()) {
  return { work: activeRuns.size };
}

export function hasClaimCapacity(activeRuns, concurrency) {
  return activeRunnerLoad(activeRuns).work < concurrency;
}

export function authOkFor(capability, health = {}, selection = {}) {
  const selectedHarness = selection?.agentHarness || (selection?.piProvider || selection?.piModel ? "pi" : "");
  if (selectedHarness === "codex") {
    return health?.codex?.ok === false ? [`codex: ${health.codex.error || "not authenticated"}`] : [];
  }
  if (selectedHarness === "claude") {
    return health?.claude?.ok === false ? [`claude: ${health.claude.error || "not authenticated"}`] : [];
  }
  if (selectedHarness === "pi") return [];

  const agents = Array.isArray(capability?.requiredAgents) ? capability.requiredAgents : [];
  const text = `${capability?.slug || ""} ${agents.join(" ")} ${JSON.stringify(capability?.workflow || {})}`.toLowerCase();
  const needsClaude = /claude|implementation-agent|researcher|product-manager|taste-agent|design-director|run-knowledge-analyst/.test(text);
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
  if (!entry) return [`workflow ${capability?.slug || "unknown"} has no workflow.entry`];
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const failures = [];
  if (!existsSync(workflowPath)) failures.push(`workflow file not found: ${workflowPath}`);
  failures.push(...preflightImproveRepo(run, capability, { workspace, env, gitBin, gitEnv }));
  // Malformed harness selection (bad harness name, key VALUE pasted where a
  // key NAME belongs, ...) is a config error — fail closed before launch. The
  // issue strings never contain the rejected value.
  const harness = resolveHarnessSelection({ capability, input: run?.input || {} });
  failures.push(...harness.issues);
  if (!harness.issues.length) {
    if (harness.selection.agentHarness === "codex" && existsSync(workflowPath)) {
      const source = readFileSync(workflowPath, "utf8");
      const looseOutputFindings = lintSmithersWorkflowSource(source).filter((finding) => finding.kind === "loose-output-schema");
      if (looseOutputFindings.length) {
        failures.push(
          `workflow ${capability?.slug || "unknown"} uses z.looseObject for Smithers output schemas at line(s) ${looseOutputFindings.map((finding) => finding.line).join(", ")}; Codex native structured output requires strict object schemas with additionalProperties:false`
        );
      }
    }
    failures.push(...authOkFor(capability, health, harness.selection));
  }
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
  // The bundle id becomes part of the materialized file name — reject anything
  // outside the store's id alphabet so it can never traverse out of bundleDir.
  if (!/^[A-Za-z0-9_-]+$/.test(bundleId)) {
    throw new Error(`workflow ${slug} references workflow bundle id with unsupported characters; refusing to materialize`);
  }
  if (!bundle || typeof bundle.code !== "string") {
    throw new Error(
      `workflow ${slug} references workflow bundle ${bundleId}, but the claim payload carried no bundle code; refusing to fall back to a workflow template`
    );
  }
  if (bundle.id && bundle.id !== bundleId) {
    throw new Error(`claim payload carried workflow bundle ${bundle.id}, but workflow ${slug} references ${bundleId}`);
  }
  const sha256 = workflowBundleSha256(bundle.code);
  if (sha256 !== bundle.sha256) {
    throw new Error(`workflow bundle ${bundleId} sha256 mismatch: stored ${bundle.sha256 || "(none)"}, materialized ${sha256}`);
  }
  const language = /^[a-z0-9]{1,10}$/.test(String(bundle.language || "")) ? bundle.language : "tsx";
  // Materialize INTO .smithers/workflows (with a per-run filename) rather
  // than an isolated per-run directory: bundle source uses the same relative
  // imports as checked-in templates ("./improve-repo.js", "../agents"), and
  // those only resolve from the workflows directory — an isolated directory
  // breaks every bundle-backed workflow with a relative import at load time.
  const runSegment = String(run.id);
  if (!/^[A-Za-z0-9_-]+$/.test(runSegment)) {
    throw new Error(`run id ${runSegment} has unsupported characters; refusing to materialize workflow bundle`);
  }
  const bundleDir = path.join(workspace, ".smithers", "workflows");
  mkdirSync(bundleDir, { recursive: true });
  const entry = path.join(bundleDir, `${bundleId}.v${bundle.version || 0}.${runSegment}.${language}`);
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
