import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeSupervisorRunsQuery,
  approvalPolicyRequiresRunStartApproval,
  normalizeRun,
  normalizeRunEvent,
  runCreateRecord,
  runClaimAssignmentQuery,
  runEventRecord,
  runEventInsertQuery,
  runEventListQuery,
  runInsertQuery,
  runLookupQuery,
  runOwnerTokenQuery,
  runStartApprovalPayload,
  runUpdateQuery,
  runUpdateParams
} from "../src/runRecords.js";

describe("run record helpers", () => {
  it("normalizes run rows into API-facing run records", () => {
    const run = normalizeRun({
      id: "run_1",
      capability_id: "cap_1",
      capability_slug: "hello",
      capability_name: "Hello",
      workflow_version: 2,
      runner_id: "runner_1",
      status: "running",
      current_step: "build",
      input: '{"goal":"ship"}',
      output: '{"ok":true}',
      error: "",
      capability_sha: "",
      parent_run_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      assigned_at: "2026-01-01T00:01:00.000Z",
      started_at: "2026-01-01T00:02:00.000Z",
      completed_at: null,
      updated_at: "2026-01-01T00:03:00.000Z"
    });

    assert.equal(run.id, "run_1");
    assert.equal(run.capabilitySlug, "hello");
    assert.deepEqual(run.input, { goal: "ship" });
    assert.deepEqual(run.output, { ok: true });
    assert.equal(run.capabilitySha, null);
    assert.equal(run.parentRunId, null);
  });

  it("builds whitelisted run update params and serializes object values", () => {
    const update = runUpdateParams({
      runId: "run_1",
      updates: {
        status: "succeeded",
        output: { ok: true },
        ignored: "nope"
      },
      allowed: ["status", "output"],
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(update.sets, ["status=$status", "output=$output"]);
    assert.deepEqual(update.params, {
      id: "run_1",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "succeeded",
      output: '{"ok":true}'
    });

    assert.deepEqual(runUpdateQuery(update), {
      sql: "UPDATE runs SET status=$status, output=$output, updated_at=$updated_at WHERE id=$id",
      params: update.params
    });
  });

  it("builds run owner and claim assignment queries", () => {
    assert.deepEqual(runOwnerTokenQuery("run_1"), {
      sql: `SELECT runners.token_id AS token_id
       FROM runs
       JOIN runners ON runners.id = runs.runner_id
      WHERE runs.id = ?`,
      params: ["run_1"]
    });
    assert.deepEqual(runClaimAssignmentQuery({
      runId: "run_1",
      runnerId: "runner_1",
      timestamp: "2026-01-01T00:00:00.000Z"
    }), {
      sql: "UPDATE runs SET runner_id=?, status='assigned', current_step='assigned to runner', assigned_at=?, updated_at=? WHERE id=? AND status='queued' AND (runner_id IS NULL OR runner_id=?)",
      params: ["runner_1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "run_1", "runner_1"]
    });
  });

  it("builds run create records with status and parent metadata", () => {
    const capability = {
      id: "cap_1",
      slug: "hello",
      name: "Hello",
      version: 3
    };

    assert.deepEqual(runCreateRecord({
      runId: "run_1",
      capability,
      input: { topic: "x" },
      options: {
        runnerId: "runner_1",
        capabilitySha: "  abc123  ",
        parentRunId: " parent_1 "
      },
      approvalRequired: true,
      timestamp: "2026-01-01T00:00:00.000Z"
    }), [
      "run_1",
      "cap_1",
      "hello",
      "Hello",
      3,
      "runner_1",
      "waiting_approval",
      "waiting for approval",
      '{"topic":"x"}',
      "abc123",
      "parent_1",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]);

    assert.equal(runCreateRecord({
      runId: "run_2",
      capability,
      input: {},
      options: {},
      approvalRequired: false,
      timestamp: "2026-01-01T00:00:00.000Z"
    })[6], "queued");

    assert.deepEqual(runInsertQuery(), {
      sql: `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, runner_id, status,
      current_step, input, capability_sha, parent_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    });
  });

  it("builds run lookup and active supervisor queries", () => {
    assert.deepEqual(runLookupQuery("run_1"), {
      sql: "SELECT * FROM runs WHERE id = ?",
      params: ["run_1"]
    });
    assert.deepEqual(activeSupervisorRunsQuery(), {
      sql: `SELECT * FROM runs
      WHERE capability_slug = 'run-smithers'
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 200`,
      params: []
    });
  });

  it("decides and builds run-start approval payloads", () => {
    assert.equal(approvalPolicyRequiresRunStartApproval({ runStartApproval: true }), true);
    assert.equal(approvalPolicyRequiresRunStartApproval({ requireRunStartApproval: true }), true);
    assert.equal(approvalPolicyRequiresRunStartApproval({ workflowStartApproval: true }), true);
    assert.equal(approvalPolicyRequiresRunStartApproval(null), false);

    const payload = runStartApprovalPayload({
      capability: {
        slug: "deploy",
        name: "Deploy",
        version: 5,
        workflow: { engine: "smithers", entry: "workflow.tsx" }
      },
      input: { target: "prod" },
      requestedBy: "api",
      notifyTelegram: true,
      origin: { type: "rerun" },
      execution: { requested: true, mode: "fast" }
    });

    assert.equal(payload.kind, "run_start");
    assert.equal(payload.workflow.entry, "workflow.tsx");
    assert.equal(payload.notifyTelegram, true);
    assert.deepEqual(payload.origin, { type: "rerun" });
    assert.deepEqual(payload.execution, { requested: true, mode: "fast" });
  });

  it("builds and normalizes run event records", () => {
    const record = runEventRecord({
      id: "evt_1",
      runId: "run_1",
      type: "workflow.step",
      message: "Build started",
      data: { step: "build" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(record, {
      id: "evt_1",
      run_id: "run_1",
      type: "workflow.step",
      message: "Build started",
      data: '{"step":"build"}',
      created_at: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(normalizeRunEvent(record), {
      id: "evt_1",
      runId: "run_1",
      type: "workflow.step",
      message: "Build started",
      data: { step: "build" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(runEventInsertQuery(), {
      sql: "INSERT INTO run_events (id, run_id, type, message, data, created_at) VALUES ($id, $run_id, $type, $message, $data, $created_at)"
    });
    assert.deepEqual(runEventListQuery("run_1"), {
      sql: "SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC",
      params: ["run_1"]
    });
  });
});
