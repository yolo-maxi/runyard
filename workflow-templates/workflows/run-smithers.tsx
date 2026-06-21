// smithers-source: authored
// smithers-display-name: run-smithers (supervising wrapper)
// smithers-description: Supervising wrapper around a wrapped capability run. Records child lineage, retries recoverable failures, and requests approval after three identical normalized error fingerprints.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  classifyChildState,
  createWatcherState,
  decideNextAction,
  normalizeErrorFingerprint,
  recordChildAttempt,
  recordRepairAttempt,
  watcherSummary
} from "./run-smithers-watcher.js";
import { resolveImproveRepo } from "./improve-repo.js";
import { syncWorkflowToWorkspace, workflowFileFromEntry } from "./workflow-repair.js";

const HUB_URL = String(process.env.RUN_SMITHERS_HUB_URL || process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117").replace(/\/$/, "");
const HUB_TOKEN = process.env.RUN_SMITHERS_HUB_TOKEN || process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || "";
const POLL_INTERVAL_MS = Number(process.env.RUN_SMITHERS_POLL_INTERVAL_MS || 5_000);
const POLL_DEADLINE_MS = Number(process.env.RUN_SMITHERS_POLL_DEADLINE_MS || 60 * 60 * 1000);

const inputSchema = z.object({
  wrappedCapability: z.string().min(1).describe("Slug of the capability/workflow to wrap."),
  wrappedInput: z.record(z.string(), z.unknown()).default({}),
  goal: z.string().default("").describe("Outcome the watcher is trying to finish."),
  maxAttempts: z.number().int().min(1).max(32).default(RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS),
  fingerprintThreshold: z.number().int().min(1).max(10).default(RUN_SMITHERS_FINGERPRINT_LIMIT),
  // One bounded workflow-code repair per supervised child by default. Set to 0
  // to disable self-correction (pure wrap/retry/escalate), or raise carefully.
  maxCodeRepairs: z.number().int().min(0).max(3).default(RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS),
  // Internal bypass token the Hub minted for this supervising run. The watcher
  // echoes it on every child spawn so the Hub recognizes the child as already
  // supervised and does not re-wrap it (infinite-wrapping guard).
  __supervisionToken: z.string().default("")
});

const superviseOut = z.looseObject({
  outcome: z.string().default("running"),
  wrappedRunId: z.string().default(""),
  lineage: z.array(z.unknown()).default([]),
  repairs: z.array(z.unknown()).default([]),
  codeRepairs: z.number().default(0),
  approval: z.unknown().nullable().default(null),
  summary: z.string().default("")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  supervise: superviseOut
});

async function hubJson(pathname: string, options: { method?: string; body?: unknown } = {}) {
  if (!HUB_TOKEN) {
    throw new Error("run-smithers needs SMITHERS_HUB_TOKEN or RUN_SMITHERS_HUB_TOKEN on the runner.");
  }
  const response = await fetch(`${HUB_URL}${pathname}`, {
    method: options.method || "GET",
    headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hub ${options.method || "GET"} ${pathname} failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function spawnChildRun(
  state: ReturnType<typeof createWatcherState>,
  wrappedInput: Record<string, unknown>,
  supervisionToken: string
) {
  const created = await hubJson(`/api/capabilities/${encodeURIComponent(state.capabilitySlug)}/run`, {
    method: "POST",
    body: {
      input: {
        ...wrappedInput,
        // Internal bypass marker: tells the Hub this child run is already
        // supervised by this run-smithers run, so it is dispatched directly
        // instead of being wrapped again. The token is validated server-side
        // against this supervising run and redacted from API responses.
        __supervisedChild: { token: supervisionToken }
      },
      origin: {
        type: "run-smithers",
        label: `run-smithers wrapper${state.parentRunId ? ` ${state.parentRunId}` : ""}`,
        parentRunId: state.parentRunId
      }
    }
  });
  return created?.run || null;
}

async function pollChildRun(runId: string) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const detail = await hubJson(`/api/runs/${encodeURIComponent(runId)}`);
    const run = detail?.run;
    const classification = classifyChildState(run);
    if (classification.terminal || classification.kind === "waiting_approval") {
      return { run, classification };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { run: null, classification: classifyChildState(null) };
}

// Resolve the wrapped capability's workflow file + the repo that ships its
// source (workflow templates always live in the Hub repo). Returns null if we
// cannot resolve enough to attempt a safe repair.
async function resolveRepairTarget(state: ReturnType<typeof createWatcherState>) {
  let entry = "";
  try {
    const detail = await hubJson(`/api/capabilities/${encodeURIComponent(state.capabilitySlug)}`);
    entry = detail?.capability?.workflow?.entry || "";
  } catch {
    /* fall back to slug-derived filename */
  }
  const file = workflowFileFromEntry(entry, state.capabilitySlug);
  if (!file) return null;
  let repoRoot = "";
  try {
    repoRoot = resolveImproveRepo({}, { env: process.env, cwd: process.cwd() });
  } catch {
    return null;
  }
  const workspaceDir = process.env.SMITHERS_WORKSPACE || process.cwd();
  return { entry, file, repoRoot, workspaceDir };
}

// Attempt exactly one bounded workflow-code repair: spawn a gated
// implement-change-gated child run scoped to the single failing workflow file
// (reusing the established gated contract — pnpm test, staged diff, sane commit,
// no broad refactor), then sync the repaired template into the runner workspace
// so the wrapped child reruns against the fix. Returns a result the watcher
// records via recordRepairAttempt. Never throws.
async function attemptWorkflowRepair(
  state: ReturnType<typeof createWatcherState>,
  decision: ReturnType<typeof decideNextAction>
) {
  const target = await resolveRepairTarget(state);
  if (!target) {
    return { ok: false, file: "", synced: false, testPassed: null, notes: `could not resolve a repair target for ${state.capabilitySlug}` };
  }
  const { entry, file, repoRoot, workspaceDir } = target;
  const failedStep = decision.failedStep ? ` at node '${decision.failedStep}'` : "";
  const workPrompt =
    `A supervised run of the "${state.capabilitySlug}" Smithers workflow failed${failedStep} with a deterministic ` +
    `workflow-code error. Fix ONLY the workflow source file workflow-templates/workflows/${file} so the error no longer occurs. ` +
    `Make the smallest correct change (null-safety / guard / typo / contract fix); do NOT refactor unrelated code, add features, or touch other files. ` +
    `Then run pnpm test and ensure it passes.\n\n=== ERROR ===\n${String(decision.error || "").slice(0, 1500)}\n=== END ===`;

  let runId = "";
  let status = "error";
  let notes = "";
  try {
    const created = await hubJson(`/api/capabilities/implement-change-gated/run`, {
      method: "POST",
      body: {
        input: {
          workPrompt,
          deploy: false,
          // Repair commits land on a dedicated branch so we never force a fix
          // straight onto main as part of autonomous self-correction.
          targetBranch: process.env.RUN_SMITHERS_REPAIR_BRANCH || "smithers-self-repair",
          commitMessage: `fix: repair ${file} (${state.capabilitySlug}) — supervised self-correction`,
          repoDir: repoRoot
        },
        origin: {
          type: "run-smithers-repair",
          label: `run-smithers self-repair of ${file}`,
          parentRunId: state.parentRunId
        }
      }
    });
    runId = created?.run?.id || "";
    if (!runId) {
      return { ok: false, file, synced: false, testPassed: null, notes: "repair child run was not created" };
    }
    const polled = await pollChildRun(runId);
    status = polled.run?.status || polled.classification.kind;
    notes = String(polled.run?.error || "").slice(0, 300);
  } catch (error) {
    return { ok: false, file, runId, synced: false, testPassed: null, notes: `repair dispatch failed: ${String(error).slice(0, 200)}` };
  }

  const testPassed = status === "succeeded";
  if (!testPassed) {
    return { ok: false, file, runId, synced: false, testPassed: false, notes: notes || `repair child ended as ${status}` };
  }

  // Sync the repaired template from the repo into the runner workspace so the
  // wrapped child rerun actually executes the fix.
  const sync = syncWorkflowToWorkspace({ repoRoot, workspaceDir, entry, slug: state.capabilitySlug });
  return {
    ok: Boolean(sync.ok),
    file,
    runId,
    synced: Boolean(sync.ok),
    testPassed: true,
    notes: sync.ok ? `repaired + synced ${file} into the runner workspace` : `repair committed but workspace sync failed: ${sync.error || "unknown"}`
  };
}

async function requestApprovalCheckpoint(state: ReturnType<typeof createWatcherState>, decision: ReturnType<typeof decideNextAction>) {
  await hubJson(`/api/approvals`, {
    method: "POST",
    body: {
      title: `run-smithers needs approval for ${state.capabilitySlug}`,
      description: decision.reason,
      requestedBy: `workflow: run-smithers`,
      payload: {
        kind: "checkpoint",
        approvalKind: "checkpoint",
        approvalScope: "workflow_checkpoint",
        capability: "run-smithers",
        wrappedCapability: state.capabilitySlug,
        watcher: watcherSummary(state),
        fingerprint: decision.fingerprint || "",
        options: decision.options || []
      }
    }
  }).catch((error) => {
    // Approval surface is best-effort; the watcher's lineage already carries
    // the diagnostic so the supervising run is not silently masked.
    return { error: String(error).slice(0, 200) };
  });
}

export default smithers((ctx) => (
  <Workflow name="run-smithers">
    <Sequence>
      <Task id="supervise" output={outputs.supervise} retries={0} timeoutMs={POLL_DEADLINE_MS + 60_000}>
        {async () => {
          const state = createWatcherState({
            goal: ctx.input.goal,
            capabilitySlug: ctx.input.wrappedCapability,
            input: ctx.input.wrappedInput || {},
            maxAttempts: ctx.input.maxAttempts,
            fingerprintThreshold: ctx.input.fingerprintThreshold,
            maxCodeRepairs: ctx.input.maxCodeRepairs
          });

          let wrappedRunId = "";
          let lastClassification = classifyChildState(null);

          while (state.attempts.length < state.maxAttempts && !state.approvalRequested) {
            const child = await spawnChildRun(state, ctx.input.wrappedInput || {}, ctx.input.__supervisionToken || "");
            if (!child) {
              recordChildAttempt(state, {
                runId: "",
                capability: state.capabilitySlug,
                status: "error",
                error: "failed to create child run"
              });
              continue;
            }
            wrappedRunId = child.id;
            const polled = await pollChildRun(child.id);
            lastClassification = polled.classification;
            recordChildAttempt(state, {
              runId: child.id,
              capability: state.capabilitySlug,
              status: polled.run?.status || lastClassification.kind,
              error: polled.run?.error || "",
              failedStep: polled.run?.currentStep || "",
              checkpoint: lastClassification.checkpoint || null,
              recordedAt: polled.run?.completedAt || polled.run?.updatedAt || ""
            });
            const decision = decideNextAction(state, lastClassification);
            if (decision.action === "succeed") break;
            if (decision.action === "approval") {
              await requestApprovalCheckpoint(state, decision);
              break;
            }
            if (decision.action === "give_up") break;
            if (decision.action === "repair") {
              // One bounded workflow-code repair, then loop to rerun the child
              // against the fix. recordRepairAttempt enforces the per-fingerprint
              // cap, so a failed/again-failing repair escalates next iteration.
              const repair = await attemptWorkflowRepair(state, decision);
              recordRepairAttempt(state, {
                fingerprint: decision.fingerprint,
                file: repair.file,
                failedStep: decision.failedStep,
                ok: repair.ok,
                synced: repair.synced,
                testPassed: repair.testPassed,
                notes: repair.notes
              });
              // If the repair could not even run/sync, escalate now rather than
              // rerunning against unchanged code.
              if (!repair.ok) {
                state.approvalRequested = true;
                await requestApprovalCheckpoint(state, {
                  ...decision,
                  action: "approval",
                  reason: `Automated workflow-code repair did not complete (${repair.notes || "unknown"}); operator review required.`
                });
                break;
              }
              continue;
            }
            // retry / observe / wait_approval all loop until a terminal decision.
          }

          const fingerprint = normalizeErrorFingerprint(
            state.attempts[state.attempts.length - 1]?.error || ""
          );

          const summaryState = watcherSummary(state);
          return {
            outcome: state.outcome || (state.approvalRequested ? "needs_recovery" : "abandoned"),
            wrappedRunId,
            lineage: summaryState.lineage,
            repairs: summaryState.repairs,
            codeRepairs: summaryState.codeRepairs,
            approval: state.approvalRequested
              ? {
                  reason: "Operator approval requested after autonomous attempts (and any one-shot workflow-code repair) did not finish the goal.",
                  fingerprint
                }
              : null,
            summary: `attempts=${state.attempts.length} maxAttempts=${state.maxAttempts} threshold=${state.fingerprintThreshold} codeRepairs=${summaryState.codeRepairs}/${state.maxCodeRepairs} outcome=${state.outcome || (state.approvalRequested ? "needs_recovery" : "abandoned")}`
          };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
