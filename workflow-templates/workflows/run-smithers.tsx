// smithers-source: authored
// smithers-display-name: run-smithers (supervising wrapper)
// smithers-description: Supervising wrapper around a wrapped capability run. Records child lineage, retries recoverable failures, and requests approval after three identical normalized error fingerprints.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  classifyChildState,
  createWatcherState,
  decideNextAction,
  normalizeErrorFingerprint,
  recordChildAttempt,
  watcherSummary
} from "../../src/runSmithersWatcher.js";

const HUB_URL = String(process.env.RUN_SMITHERS_HUB_URL || process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117").replace(/\/$/, "");
const HUB_TOKEN = process.env.RUN_SMITHERS_HUB_TOKEN || process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || "";
const POLL_INTERVAL_MS = Number(process.env.RUN_SMITHERS_POLL_INTERVAL_MS || 5_000);
const POLL_DEADLINE_MS = Number(process.env.RUN_SMITHERS_POLL_DEADLINE_MS || 60 * 60 * 1000);

const inputSchema = z.object({
  wrappedCapability: z.string().min(1).describe("Slug of the capability/workflow to wrap."),
  wrappedInput: z.record(z.string(), z.unknown()).default({}),
  goal: z.string().default("").describe("Outcome the watcher is trying to finish."),
  maxAttempts: z.number().int().min(1).max(32).default(RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS),
  fingerprintThreshold: z.number().int().min(1).max(10).default(RUN_SMITHERS_FINGERPRINT_LIMIT)
});

const superviseOut = z.looseObject({
  outcome: z.string().default("running"),
  wrappedRunId: z.string().default(""),
  lineage: z.array(z.unknown()).default([]),
  approval: z.unknown().nullable().default(null),
  summary: z.string().default("")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  supervise: superviseOut
});

const supervisor = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  cwd: "/tmp",
  systemPrompt:
    "You are the run-smithers supervising watcher. You wrap exactly one child capability. " +
    "Record child run id, capability, current/failed step, checkpoint, retry count, and normalized error fingerprint for every terminal child transition. " +
    "Never mark the wrapped goal a success unless the child workflow reaches a terminal `succeeded` state. " +
    "After three identical normalized error fingerprints, stop autonomous retry and request operator approval with concrete options."
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

async function spawnChildRun(state: ReturnType<typeof createWatcherState>, wrappedInput: Record<string, unknown>) {
  const created = await hubJson(`/api/capabilities/${encodeURIComponent(state.capabilitySlug)}/run`, {
    method: "POST",
    body: {
      input: wrappedInput,
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
      <Task id="supervise" output={outputs.supervise} agent={supervisor} retries={0} timeoutMs={POLL_DEADLINE_MS + 60_000}>
        {async () => {
          const state = createWatcherState({
            goal: ctx.input.goal,
            capabilitySlug: ctx.input.wrappedCapability,
            input: ctx.input.wrappedInput || {},
            maxAttempts: ctx.input.maxAttempts,
            fingerprintThreshold: ctx.input.fingerprintThreshold
          });

          let wrappedRunId = "";
          let lastClassification = classifyChildState(null);

          while (state.attempts.length < state.maxAttempts && !state.approvalRequested) {
            const child = await spawnChildRun(state, ctx.input.wrappedInput || {});
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
            // retry / observe / wait_approval all loop until a terminal decision.
          }

          const fingerprint = normalizeErrorFingerprint(
            state.attempts[state.attempts.length - 1]?.error || ""
          );

          return {
            outcome: state.outcome || (state.approvalRequested ? "needs_recovery" : "abandoned"),
            wrappedRunId,
            lineage: watcherSummary(state).lineage,
            approval: state.approvalRequested
              ? {
                  reason: "Same normalized error fingerprint repeated; operator approval requested.",
                  fingerprint
                }
              : null,
            summary: `attempts=${state.attempts.length} maxAttempts=${state.maxAttempts} threshold=${state.fingerprintThreshold} outcome=${state.outcome || (state.approvalRequested ? "needs_recovery" : "abandoned")}`
          };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
