import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end pause/resume lifecycle proof over the real HTTP API against an
// isolated Hub (temp data dir): running run with an active runner slot →
// pause → slot release with the runner pin kept → resume → terminal outcome —
// for the checkpointed path, the no-checkpoint/from-scratch path, and the
// resume-failed (checkpoint missing on the runner) path. This is the
// deterministic scratch smoke for the paused-runs product bar; the runner's
// own reports are simulated with the exact HTTP calls src/runner.js makes.

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-pause-e2e-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_pause_e2e_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_pause_e2e_token";

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

async function registerRunner(name) {
  const res = await api("/api/runners/register", {
    method: "POST",
    body: { name, hostname: "e2e", platform: "linux", tags: ["smithers", "vps"] }
  });
  return res.runner;
}

async function runnerByid(runnerId) {
  const res = await api("/api/runners");
  return (res.runners || []).find((runner) => runner.id === runnerId);
}

async function startClaimedRun(runner) {
  const assignment = await api(`/api/runners/${runner.id}/next-run`);
  assert.ok(assignment?.run, "runner claimed the queued run");
  await api(`/api/runs/${assignment.run.id}/start`, { method: "POST", body: {} });
  return assignment;
}

async function createQueuedRun() {
  const created = await api("/api/capabilities/hello/run", {
    method: "POST",
    body: { input: { goal: "pause/resume e2e" } }
  });
  assert.equal(created.run.status, "queued");
  return created.run;
}

describe("pause → slot release → resume → terminal (HTTP e2e)", () => {
  it("checkpointed lifecycle: pause parks, frees the slot, resume re-pins, run completes", async () => {
    const run = await createQueuedRun();
    const runner = await registerRunner("e2e-runner-checkpoint");
    const assignment = await startClaimedRun(runner);
    assert.equal(assignment.run.id, run.id);
    assert.equal((await runnerByid(runner.id)).activeRuns, 1, "running run occupies the slot");

    // Operator pauses; the owning runner then observes the pause, halts the
    // engine, and attaches the Smithers checkpoint — the exact enrichment
    // report src/runner.js sends from its hub_pause_observed branch.
    const paused = await api(`/api/runs/${run.id}/pause`, {
      method: "POST",
      body: { reason: "manual", message: "operator parked it", pausedBy: "operator" }
    });
    assert.equal(paused.run.status, "paused");
    assert.equal((await runnerByid(runner.id)).activeRuns, 0, "paused run releases the slot");
    await api(`/api/runs/${run.id}/pause`, {
      method: "POST",
      body: { pausedBy: "runner", resumable: true, resume: { smithersRunId: "run-e2e-1", strategy: "smithers_resume" } }
    });

    // Parked means parked: visible in the triage queue, immune to late
    // failure reports, still cancellable (proven on a separate run below).
    const attention = await api("/api/runs/attention");
    assert.ok(attention.attention.paused.some((row) => row.id === run.id), "paused run shows in the attention queue");
    const lateFail = await api(`/api/runs/${run.id}/fail`, { method: "POST", body: { error: "late report" } })
      .then(() => null, (error) => error);
    assert.equal(lateFail.status, 409, "a late failure report cannot flip a paused run terminal");

    const detail = await api(`/api/runs/${run.id}`);
    assert.equal(detail.run.pause.resume.smithersRunId, "run-e2e-1");
    assert.equal(detail.run.runnerId, runner.id, "runner pin kept for checkpoint locality");

    // Resume: same run re-queues with the checkpoint riding input.__resume,
    // claimable only by the pinned runner.
    const resumed = await api(`/api/runs/${run.id}/resume`, { method: "POST", body: {} });
    assert.equal(resumed.resume.strategy, "smithers_resume");
    assert.equal(resumed.resume.smithersRunId, "run-e2e-1");
    assert.equal(resumed.run.status, "queued");

    const stranger = await registerRunner("e2e-runner-stranger");
    const strangerClaim = await api(`/api/runners/${stranger.id}/next-run`);
    assert.equal(strangerClaim?.run ?? null, null, "a different runner cannot claim the pinned resume");

    const reclaim = await api(`/api/runners/${runner.id}/next-run`);
    assert.equal(reclaim.run.id, run.id);
    assert.deepEqual(reclaim.run.input.__resume, { smithersRunId: "run-e2e-1", attempt: 1 });
    await api(`/api/runs/${run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${run.id}/complete`, { method: "POST", body: { output: { ok: true, resumed: true } } });

    const final = await api(`/api/runs/${run.id}`);
    assert.equal(final.run.status, "succeeded");
    const types = final.events.map((event) => event.type);
    for (const expected of ["run.paused", "run.pause_updated", "run.resumed", "run.succeeded"]) {
      assert.ok(types.includes(expected), `timeline records ${expected}`);
    }
  });

  it("no-checkpoint resume re-runs from scratch on any runner and says so", async () => {
    const run = await createQueuedRun();
    const runner = await registerRunner("e2e-runner-scratch");
    await startClaimedRun(runner);
    await api(`/api/runs/${run.id}/pause`, { method: "POST", body: { reason: "manual", pausedBy: "operator" } });

    const resumed = await api(`/api/runs/${run.id}/resume`, { method: "POST", body: {} });
    assert.equal(resumed.resume.strategy, "rerun_from_scratch");
    assert.equal(resumed.run.runnerId, null, "no checkpoint → runner pin cleared");
    assert.equal(resumed.run.input.__resume, undefined);

    const other = await registerRunner("e2e-runner-scratch-2");
    const claim = await api(`/api/runners/${other.id}/next-run`);
    assert.equal(claim.run.id, run.id, "any live runner can claim a from-scratch resume");
    await api(`/api/runs/${run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
    assert.equal((await api(`/api/runs/${run.id}`)).run.status, "succeeded");
  });

  it("resume-failed: a missing checkpoint re-parks the run explicitly, then scratch resume finishes it", async () => {
    const run = await createQueuedRun();
    const runner = await registerRunner("e2e-runner-resume-failed");
    await startClaimedRun(runner);
    await api(`/api/runs/${run.id}/pause`, {
      method: "POST",
      body: { reason: "credits_exhausted", pausedBy: "runner", resume: { smithersRunId: "run-e2e-gone" } }
    });
    await api(`/api/runs/${run.id}/resume`, { method: "POST", body: {} });
    await startClaimedRun(runner);

    // The runner cannot find run-e2e-gone in local .smithers state; these are
    // the exact reports src/runner.js sends from its checkpoint pre-check.
    const message = "Recorded engine checkpoint run-e2e-gone was not found in this runner's local .smithers state";
    await api(`/api/runs/${run.id}/events`, {
      method: "POST",
      body: { type: "runner.resume_checkpoint_missing", message, data: { smithersRunId: "run-e2e-gone", reason: "resume_failed" } }
    });
    const repaused = await api(`/api/runs/${run.id}/pause`, {
      method: "POST",
      body: { reason: "resume_failed", message, pausedBy: "runner", resumable: true }
    });
    assert.equal(repaused.run.status, "paused");
    assert.equal(repaused.run.pause.reason, "resume_failed");
    assert.equal(repaused.run.pause.resume, undefined, "stale checkpoint dropped from the new pause record");
    assert.match(repaused.run.pause.requiredAction.label, /re-run from scratch/);

    // Insisting on the dropped checkpoint is refused with a real explanation.
    const insist = await api(`/api/runs/${run.id}/resume`, { method: "POST", body: { strategy: "smithers_resume" } })
      .then(() => null, (error) => error);
    assert.equal(insist.status, 409);
    assert.match(insist.message, /no engine checkpoint/);

    // The honest fallback completes the run.
    const second = await api(`/api/runs/${run.id}/resume`, { method: "POST", body: {} });
    assert.equal(second.resume.strategy, "rerun_from_scratch");
    assert.equal(second.resume.attempt, 2);
    const other = await registerRunner("e2e-runner-resume-failed-2");
    const claim = await api(`/api/runners/${other.id}/next-run`);
    assert.equal(claim.run.id, run.id);
    await api(`/api/runs/${run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
    assert.equal((await api(`/api/runs/${run.id}`)).run.status, "succeeded");
  });

  it("cancel remains the exit for a parked run an operator gives up on", async () => {
    const run = await createQueuedRun();
    const runner = await registerRunner("e2e-runner-cancel");
    await startClaimedRun(runner);
    await api(`/api/runs/${run.id}/pause`, { method: "POST", body: { reason: "manual", pausedBy: "operator" } });
    const cancelled = await api(`/api/runs/${run.id}/cancel`, { method: "POST", body: { reason: "gave up" } });
    assert.equal(cancelled.run.status, "cancelled");
  });
});
