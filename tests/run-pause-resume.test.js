import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// First-class paused runs: a recoverable external interruption (credits/quota
// exhausted, operator pause) parks the run as non-terminal `paused` — durable,
// reap-exempt, slot-free, and resumable from the recorded Smithers checkpoint
// through the existing input.__resume launch path.

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-pause-resume-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_pause_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const {
  addRunEvent,
  claimNextRun,
  createRun,
  db,
  getCapability,
  getRun,
  getRunner,
  listRunEvents,
  reapStuckRunIds,
  registerRunner,
  RUN_TERMINAL,
  transitionRun,
  updateRun
} = await import("../src/db.js");
const { PAUSE_REASONS } = await import("../src/runPause.js");
const { env } = await import("../src/env.js");
const { now } = await import("../src/ids.js");
const { canTransitionRun, shouldReleaseRunnerSlotOnTransition } = await import("../src/runLifecyclePolicy.js");
const {
  buildRunPause,
  classifyPauseReason,
  mergeRunPause,
  pauseSignalFromProviderResponse
} = await import("../src/runPause.js");
const { createRunPauseStore } = await import("../src/runPauseStore.js");
const { createGatewayHandlers } = await import("../src/gatewayRoutes.js");
const { gatewayRunToken } = await import("../src/meteringGateway.js");
const { cleanRerunInput, logicalRerunInput } = await import("../src/runRerun.js");
const { smithersLaunchRequest } = await import("../src/runnerSmithersRuntime.js");

const pauseStore = createRunPauseStore({ getRun, getRunner, transitionRun, updateRun, addRunEvent, now });

function markRunnerOffline(runnerId) {
  db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 86_400_000).toISOString(), runnerId);
}

function runningRun({ input = { topic: "pause" }, tags = ["smithers", "vps"] } = {}) {
  const capability = getCapability("hello");
  const run = createRun(capability, input);
  const runner = registerRunner({ name: `runner-${run.id}`, hostname: "test", tags });
  const assignment = claimNextRun(runner.id);
  assert.equal(assignment.run.id, run.id);
  transitionRun(run.id, "running", { current_step: "running", started_at: now() });
  return { runId: run.id, runnerId: runner.id };
}

function eventTypes(runId) {
  return listRunEvents(runId).map((event) => event.type);
}

describe("pause lifecycle policy", () => {
  it("paused is a valid non-terminal status with the intended edges", () => {
    assert.equal(RUN_TERMINAL.has("paused"), false);
    assert.equal(canTransitionRun("running", "paused"), true);
    assert.equal(canTransitionRun("assigned", "paused"), true);
    assert.equal(canTransitionRun("paused", "queued"), true);
    assert.equal(canTransitionRun("paused", "cancelled"), true);
    // No automatic/late failure may flip a parked run terminal.
    assert.equal(canTransitionRun("paused", "failed"), false);
    assert.equal(canTransitionRun("paused", "provider_limited"), false);
    assert.equal(canTransitionRun("paused", "budget_exceeded"), false);
    // Only active runs pause; queued/terminal runs do not.
    assert.equal(canTransitionRun("queued", "paused"), false);
    assert.equal(canTransitionRun("succeeded", "paused"), false);
    assert.equal(canTransitionRun("waiting_approval", "paused"), false);
  });

  it("pausing releases the runner slot like a terminal transition", () => {
    const current = { runnerId: "rnr_1", status: "running" };
    assert.equal(shouldReleaseRunnerSlotOnTransition(current, "paused"), true);
    assert.equal(shouldReleaseRunnerSlotOnTransition({ ...current, status: "assigned" }, "paused"), true);
    // Cancelling an ALREADY paused run must not double-release.
    assert.equal(shouldReleaseRunnerSlotOnTransition({ runnerId: "rnr_1", status: "paused" }, "cancelled"), false);
  });
});

describe("pause classification", () => {
  it("classifies clear credit/quota exhaustion and nothing else", () => {
    assert.equal(classifyPauseReason("Your credit balance is too low to access the API"), "credits_exhausted");
    assert.equal(classifyPauseReason("HTTP 402 Payment Required"), "credits_exhausted");
    assert.equal(classifyPauseReason("error: insufficient_quota — check plan and billing"), "quota_exhausted");
    assert.equal(classifyPauseReason("You exceeded your current quota"), "quota_exhausted");
    // Transient throttling stays a terminal provider_limited failure, not a pause.
    assert.equal(classifyPauseReason("429 rate limit exceeded, retry after 3s"), null);
    assert.equal(classifyPauseReason("temporarily overloaded"), null);
    assert.equal(classifyPauseReason(""), null);
  });

  it("treats an upstream provider 402 as a structured credit signal", () => {
    const signal = pauseSignalFromProviderResponse({ status: 402, bodyText: '{"error":{"message":"no balance"}}' });
    assert.equal(signal.reason, "credits_exhausted");
    assert.match(signal.message, /402/);
    const bodySignal = pauseSignalFromProviderResponse({ status: 400, bodyText: "insufficient_quota for this key" });
    assert.equal(bodySignal.reason, "quota_exhausted");
    assert.equal(pauseSignalFromProviderResponse({ status: 500, bodyText: "internal error" }), null);
    assert.equal(pauseSignalFromProviderResponse({ status: 429, bodyText: "slow down" }), null);
  });

  it("builds a normalized pause record with a default required action", () => {
    const pause = buildRunPause({ reason: "credits_exhausted", message: "no balance", pausedBy: "runner", resume: { smithersRunId: "run-42" }, timestamp: "T0" });
    assert.equal(pause.reason, "credits_exhausted");
    assert.equal(pause.pausedAt, "T0");
    assert.equal(pause.pausedBy, "runner");
    assert.equal(pause.resumable, true);
    assert.deepEqual(pause.resume, { smithersRunId: "run-42", strategy: "smithers_resume" });
    assert.equal(pause.requiredAction.type, "add_credits");
    assert.match(pause.requiredAction.label, /Add credits/);
    // Unknown pausedBy values normalize instead of storing junk.
    assert.equal(buildRunPause({ pausedBy: "martian", timestamp: "T0" }).pausedBy, "system");
    assert.equal(buildRunPause({ timestamp: "T0" }).reason, "unknown");
  });

  it("merge keeps the first pause's story and only fills gaps (checkpoint)", () => {
    const original = buildRunPause({ reason: "credits_exhausted", message: "no balance", pausedBy: "gateway", timestamp: "T0" });
    const enrichment = buildRunPause({ resume: { smithersRunId: "run-77" }, pausedBy: "runner", timestamp: "T1" });
    const merged = mergeRunPause(original, enrichment);
    assert.equal(merged.reason, "credits_exhausted");
    assert.equal(merged.pausedAt, "T0");
    assert.equal(merged.pausedBy, "gateway");
    assert.equal(merged.resume.smithersRunId, "run-77");
    // An existing checkpoint is never overwritten by a later report.
    const rewrite = mergeRunPause(merged, buildRunPause({ resume: { smithersRunId: "run-99" }, timestamp: "T2" }));
    assert.equal(rewrite.resume.smithersRunId, "run-77");
  });
});

describe("pause store (real db)", () => {
  it("pauses a running run: metadata, event, slot release", () => {
    const { runId, runnerId } = runningRun();
    assert.equal(getRunner(runnerId).activeRuns, 1);

    const result = pauseStore.pauseRun(runId, {
      reason: "credits_exhausted",
      message: "credit balance is too low",
      pausedBy: "runner",
      resume: { smithersRunId: "run-1001" }
    });
    assert.equal(result.ok, true);

    const run = getRun(runId);
    assert.equal(run.status, "paused");
    assert.equal(run.pause.reason, "credits_exhausted");
    assert.equal(run.pause.resumable, true);
    assert.equal(run.pause.resume.smithersRunId, "run-1001");
    assert.match(run.pause.requiredAction.label, /Add credits/);
    // Slot accounting released; runner_id retained for checkpoint locality.
    assert.equal(getRunner(runnerId).activeRuns, 0);
    assert.equal(run.runnerId, runnerId);
    assert.ok(eventTypes(runId).includes("run.paused"));
  });

  it("re-pausing enriches instead of conflicting: the checkpoint attaches once", () => {
    const { runId } = runningRun();
    assert.equal(pauseStore.pauseRun(runId, { reason: "manual", pausedBy: "operator" }).ok, true);
    assert.equal(getRun(runId).pause.resume, undefined);

    const enriched = pauseStore.pauseRun(runId, { pausedBy: "runner", resume: { smithersRunId: "run-2002" } });
    assert.equal(enriched.ok, true);
    assert.equal(enriched.idempotent, true);
    const run = getRun(runId);
    assert.equal(run.status, "paused");
    assert.equal(run.pause.reason, "manual");
    assert.equal(run.pause.resume.smithersRunId, "run-2002");
    assert.ok(eventTypes(runId).includes("run.pause_updated"));
    assert.equal(eventTypes(runId).filter((type) => type === "run.paused").length, 1);
  });

  it("liveness/stall/deadline reaping never touches a paused run", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 1;
    env.runStallMs = 1;
    try {
      const { runId, runnerId } = runningRun();
      pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "gateway" });
      // Kill the runner heartbeat and age the run far past every backstop.
      db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 86_400_000).toISOString(), runnerId);
      db.prepare("UPDATE runs SET started_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString(), runId);
      assert.deepEqual(reapStuckRunIds(1), []);
      assert.equal(getRun(runId).status, "paused");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("resume re-queues the same run with __resume and pins it to the checkpoint's runner", () => {
    const { runId, runnerId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "runner", resume: { smithersRunId: "run-3003" } });

    const result = pauseStore.resumeRun(runId, { resumedBy: "operator" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.resume, { strategy: "smithers_resume", smithersRunId: "run-3003", attempt: 1 });
    // Pinned runner is online (fresh registration heartbeat): no warning.
    assert.equal(result.warning, undefined);

    const run = getRun(runId);
    assert.equal(run.status, "queued");
    assert.deepEqual(run.input.__resume, { smithersRunId: "run-3003", attempt: 1 });
    assert.ok(run.pause.resumedAt, "pause history records the resume");
    assert.ok(eventTypes(runId).includes("run.resumed"));

    // A different runner cannot claim it — the checkpoint lives on the
    // original runner's local .smithers state.
    const stranger = registerRunner({ name: `stranger-${runId}`, hostname: "test", tags: ["smithers", "vps"] });
    assert.equal(claimNextRun(stranger.id), null);
    const assignment = claimNextRun(runnerId);
    assert.equal(assignment.run.id, runId);
    assert.deepEqual(assignment.run.input.__resume, { smithersRunId: "run-3003", attempt: 1 });
    // The runner launch path turns __resume into `--resume <sid> --force`.
    const launch = smithersLaunchRequest({
      entry: "wf.tsx",
      input: assignment.run.input,
      workspace: temp,
      resume: assignment.run.input.__resume,
      maxInlineInputBytes: 64_000
    });
    assert.ok(launch.args.join(" ").includes("--resume run-3003 --force"));
    assert.ok(!launch.args.join(" ").includes("__resume"), "checkpoint pointer never reaches the workflow input");
  });

  it("resume without a checkpoint re-runs from scratch, says so, and unpins the runner", () => {
    const { runId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "manual", pausedBy: "operator" });
    const result = pauseStore.resumeRun(runId);
    assert.equal(result.ok, true);
    assert.equal(result.resume.strategy, "rerun_from_scratch");
    const run = getRun(runId);
    assert.equal(run.status, "queued");
    assert.equal(run.input.__resume, undefined);
    // No checkpoint means no state locality: any live runner may claim it.
    assert.equal(run.runnerId, null);
    const stranger = registerRunner({ name: `scratch-claimer-${runId}`, hostname: "test", tags: ["smithers", "vps"] });
    assert.equal(claimNextRun(stranger.id)?.run?.id, runId);
  });

  it("forced rerun_from_scratch discards the checkpoint and clears the runner pin", () => {
    const { runId, runnerId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "runner", resume: { smithersRunId: "run-4004" } });

    const result = pauseStore.resumeRun(runId, { resumedBy: "operator", strategy: "rerun_from_scratch" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.resume, { strategy: "rerun_from_scratch", attempt: 1 });
    assert.equal(result.warning, undefined);

    const run = getRun(runId);
    assert.equal(run.status, "queued");
    assert.equal(run.input.__resume, undefined, "checkpoint pointer discarded");
    assert.equal(run.runnerId, null, "runner pin cleared");
    // A different runner (not the checkpoint holder) can claim it.
    const stranger = registerRunner({ name: `fresh-claimer-${runId}`, hostname: "test", tags: ["smithers", "vps"] });
    const assignment = claimNextRun(stranger.id);
    assert.equal(assignment.run.id, runId);
    assert.notEqual(stranger.id, runnerId);
    const resumed = listRunEvents(runId).find((event) => event.type === "run.resumed");
    assert.match(resumed.message, /from scratch by request/);
    assert.match(resumed.message, /run-4004/);
  });

  it("forced smithers_resume without a recorded checkpoint is refused explicitly", () => {
    const { runId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "manual", pausedBy: "operator" });
    const result = pauseStore.resumeRun(runId, { strategy: "smithers_resume" });
    assert.equal(result.ok, false);
    assert.equal(result.code, 409);
    assert.match(result.error, /no engine checkpoint/);
    assert.equal(getRun(runId).status, "paused", "refused resume leaves the run parked");
  });

  it("an unknown strategy is a 400, not a silent default", () => {
    const { runId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "manual", pausedBy: "operator" });
    const result = pauseStore.resumeRun(runId, { strategy: "teleport" });
    assert.equal(result.ok, false);
    assert.equal(result.code, 400);
    assert.match(result.error, /unknown resume strategy/);
  });

  it("checkpointed resume onto an offline runner warns instead of waiting silently", () => {
    const { runId, runnerId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "runner", resume: { smithersRunId: "run-5005" } });
    markRunnerOffline(runnerId);

    const result = pauseStore.resumeRun(runId);
    assert.equal(result.ok, true);
    assert.equal(result.resume.strategy, "smithers_resume");
    assert.equal(result.resume.runnerOnline, false);
    assert.equal(result.resume.runnerId, runnerId);
    assert.match(result.warning, /offline/);
    assert.match(result.warning, /rerun_from_scratch/);
    // The run still resumes pinned — the checkpoint is worth waiting for — and
    // the timeline records the caveat for anyone reading the run later.
    assert.equal(getRun(runId).runnerId, runnerId);
    const resumed = listRunEvents(runId).find((event) => event.type === "run.resumed");
    assert.match(resumed.message, /offline/);
  });

  it("a runner-reported resume failure re-parks the run with the stale checkpoint dropped", () => {
    const { runId, runnerId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "gateway", resume: { smithersRunId: "run-6006" } });
    assert.equal(pauseStore.resumeRun(runId).resume.strategy, "smithers_resume");

    // The pinned runner claims the resumed run, starts it, then discovers the
    // checkpoint is gone from local .smithers state and reports resume_failed
    // — exactly what src/runner.js does via resumeCheckpointStatus().
    assert.equal(claimNextRun(runnerId).run.id, runId);
    transitionRun(runId, "running", { current_step: "running", started_at: now() });
    const repause = pauseStore.pauseRun(runId, {
      reason: PAUSE_REASONS.RESUME_FAILED,
      message: "Recorded engine checkpoint run-6006 was not found in this runner's local .smithers state",
      pausedBy: "runner"
    });
    assert.equal(repause.ok, true);

    const run = getRun(runId);
    assert.equal(run.status, "paused");
    assert.equal(run.pause.reason, "resume_failed");
    assert.equal(run.pause.resume, undefined, "stale checkpoint is NOT carried into the new pause record");
    assert.match(run.pause.requiredAction.label, /re-run from scratch/);

    // The next resume is honest: rerun_from_scratch, pointer gone, pin cleared.
    const second = pauseStore.resumeRun(runId);
    assert.equal(second.ok, true);
    assert.equal(second.resume.strategy, "rerun_from_scratch");
    assert.equal(second.resume.attempt, 2, "attempt count survives the failed resume");
    const requeued = getRun(runId);
    assert.equal(requeued.input.__resume, undefined);
    assert.equal(requeued.runnerId, null);
  });

  it("resume refuses non-paused runs and pauses marked not resumable", () => {
    const { runId } = runningRun();
    const active = pauseStore.resumeRun(runId);
    assert.equal(active.ok, false);
    assert.equal(active.code, 409);

    pauseStore.pauseRun(runId, { reason: "manual", pausedBy: "operator", resumable: false });
    const blocked = pauseStore.resumeRun(runId);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 409);
    assert.match(blocked.error, /not resumable/);
    assert.equal(pauseStore.resumeRun("run_missing").code, 404);
  });

  it("cancel still works from paused", () => {
    const { runId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "gateway" });
    const result = transitionRun(runId, "cancelled", { current_step: "cancelled", completed_at: now() });
    assert.equal(result.ok, true);
    assert.equal(getRun(runId).status, "cancelled");
  });

  it("a late runner failure report cannot flip a paused run terminal", () => {
    const { runId } = runningRun();
    pauseStore.pauseRun(runId, { reason: "credits_exhausted", pausedBy: "gateway" });
    const late = transitionRun(runId, "provider_limited", { error: "quota" });
    assert.equal(late.ok, false);
    assert.equal(late.code, 409);
    assert.equal(getRun(runId).status, "paused");
  });

  it("pause refuses terminal and missing runs", () => {
    const { runId } = runningRun();
    transitionRun(runId, "succeeded", { completed_at: now() });
    const done = pauseStore.pauseRun(runId, { reason: "manual" });
    assert.equal(done.ok, false);
    assert.equal(done.code, 409);
    assert.equal(pauseStore.pauseRun("run_missing", {}).code, 404);
  });

  it("reruns of a resumed run never inherit the checkpoint pointer", () => {
    const input = { topic: "x", __resume: { smithersRunId: "run-old", attempt: 2 } };
    assert.equal(cleanRerunInput(input, "run_prev").__resume, undefined);
    assert.equal(logicalRerunInput({ input, capabilitySlug: "hello" }).input.__resume, undefined);
  });
});

describe("gateway credit exhaustion pauses instead of failing", () => {
  const SECRET = "test-secret";
  const GATEWAY_CAPABILITY = { slug: "research", workflow: {} };

  function gatewayRun(over = {}) {
    return {
      id: "run_gpause",
      capabilitySlug: "research",
      status: "running",
      budget: null,
      usage: null,
      input: {
        agentHarness: "pi",
        metering: "gateway",
        piProvider: "venice",
        piModel: "llama-3.3-70b",
        piBaseUrl: "https://api.venice.example/v1",
        piApiKeyEnv: "VENICE_API_KEY"
      },
      ...over
    };
  }

  function resStub() {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) { res.statusCode = code; return res; },
      set() { return res; },
      json(value) { res.body = value; return res; },
      send(value) { res.body = value; return res; },
      write() { return true; },
      end() {},
      flushHeaders() {}
    };
    return res;
  }

  function harness({ run, upstream, budget = { exceeded: false } }) {
    const pauseCalls = [];
    const handlers = createGatewayHandlers({
      env: { sessionSecret: SECRET },
      processEnv: {},
      getRun: (id) => (id === run.id ? run : null),
      getCapability: () => GATEWAY_CAPABILITY,
      getDecryptedSecretEnv: (names) => (names.includes("VENICE_API_KEY") ? { VENICE_API_KEY: "sk-upstream" } : {}),
      recordRunUsage: () => ({ ok: true, record: {}, usage: {} }),
      enforceRunBudget: () => budget,
      pauseRun: (runId, spec) => {
        pauseCalls.push({ runId, spec });
        return { ok: true, run: { id: runId, status: "paused" } };
      },
      fetchImpl: upstream,
      log: () => {}
    });
    return { handlers, pauseCalls };
  }

  const authedReq = (run) => ({
    headers: { authorization: `Bearer ${gatewayRunToken(run.id, SECRET)}` },
    body: { model: "llama-3.3-70b", messages: [] }
  });

  it("an upstream 402 pauses the run as credits_exhausted (proxied verbatim)", async () => {
    const run = gatewayRun();
    const { handlers, pauseCalls } = harness({
      run,
      upstream: async () => ({
        ok: false,
        status: 402,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ error: { type: "insufficient_credits", message: "credit balance is too low" } })
      })
    });
    const res = resStub();
    await handlers.openAiChatCompletions(authedReq(run), res);
    // The provider response still proxies through to the child untouched.
    assert.equal(res.statusCode, 402);
    assert.equal(pauseCalls.length, 1);
    assert.equal(pauseCalls[0].runId, run.id);
    assert.equal(pauseCalls[0].spec.reason, "credits_exhausted");
    assert.equal(pauseCalls[0].spec.pausedBy, "gateway");
  });

  it("the Hub's OWN budget 402 stays budget_exceeded — never a pause", async () => {
    const run = gatewayRun();
    let fetched = 0;
    const { handlers, pauseCalls } = harness({
      run,
      budget: { exceeded: true, reason: "budget exceeded: over maxTokens", stopped: true },
      upstream: async () => { fetched += 1; throw new Error("must not reach upstream"); }
    });
    const res = resStub();
    await handlers.openAiChatCompletions(authedReq(run), res);
    assert.equal(res.statusCode, 402);
    assert.equal(fetched, 0);
    assert.equal(pauseCalls.length, 0);
  });

  it("ordinary upstream errors do not pause", async () => {
    const run = gatewayRun();
    const { handlers, pauseCalls } = harness({
      run,
      upstream: async () => ({
        ok: false,
        status: 500,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify({ error: { message: "internal error" } })
      })
    });
    const res = resStub();
    await handlers.openAiChatCompletions(authedReq(run), res);
    assert.equal(res.statusCode, 500);
    assert.equal(pauseCalls.length, 0);
  });
});
