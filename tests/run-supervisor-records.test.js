import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeReapCandidatesQuery,
  failedRecoverableCandidatesQuery,
  freshRerunUpdateQuery,
  normalizeRunLineage,
  repairDispatchedUpdateQuery,
  freshRerunInput,
  resumeCheckpointEventQuery,
  resumeCheckpointFromEvent,
  resumeRunInput,
  resumeRunUpdateQuery,
  runLineageRecord,
  runLineageInsertQuery,
  runLineageListQuery,
  runProgressMarkerQuery,
  supervisorMetaUpdateQuery,
  supervisingParentStatusQuery,
  supervisingParentId,
  supervisorRunLookupQuery,
  supervisorRunStatusInputQuery,
  waitingApprovalBelongsToParent,
  waitingApprovalInputsQuery
} from "../src/runSupervisorRecords.js";

describe("run supervisor record helpers", () => {
  it("builds and normalizes lineage records", () => {
    const record = runLineageRecord({
      id: "lin_1",
      runId: "run_1",
      entry: {
        attempt: 2,
        action: "resume",
        reason: "x".repeat(650),
        fingerprint: "f".repeat(250),
        prevRunnerId: "runner_1",
        checkpoint: "smithers_1"
      },
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.reason.length, 600);
    assert.equal(record.fingerprint.length, 200);
    assert.deepEqual(normalizeRunLineage(record), {
      id: "lin_1",
      runId: "run_1",
      attempt: 2,
      action: "resume",
      reason: "x".repeat(600),
      fingerprint: "f".repeat(200),
      prevRunnerId: "runner_1",
      checkpoint: "smithers_1",
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(runLineageInsertQuery(), {
      sql: `INSERT INTO run_lineage (id, run_id, attempt, action, reason, fingerprint, prev_runner_id, checkpoint, created_at)
     VALUES ($id, $run_id, $attempt, $action, $reason, $fingerprint, $prev_runner_id, $checkpoint, $created_at)`
    });
    assert.deepEqual(runLineageListQuery("run_1"), {
      sql: "SELECT * FROM run_lineage WHERE run_id = ? ORDER BY created_at ASC",
      params: ["run_1"]
    });
  });

  it("builds supervisor resume and fresh-rerun input payloads", () => {
    assert.deepEqual(resumeRunInput("{\"topic\":\"x\",\"__resume\":{\"old\":true}}", {
      checkpoint: "sid_1",
      attempt: 3,
      timestamp: "2026-01-01T00:00:00.000Z"
    }), {
      topic: "x",
      __resume: {
        smithersRunId: "sid_1",
        attempt: 3,
        at: "2026-01-01T00:00:00.000Z"
      }
    });

    assert.deepEqual(freshRerunInput("{\"topic\":\"x\",\"__resume\":{\"smithersRunId\":\"old\"}}"), {
      topic: "x"
    });
    assert.deepEqual(freshRerunInput("bad json"), {});
  });

  it("builds supervisor checkpoint and progress queries", () => {
    assert.deepEqual(waitingApprovalInputsQuery(), {
      sql: "SELECT input FROM runs WHERE status = 'waiting_approval' ORDER BY created_at DESC LIMIT 500",
      params: []
    });
    assert.equal(waitingApprovalBelongsToParent({ input: '{"__origin":{"parentRunId":"parent_1"}}' }, "parent_1"), true);
    assert.equal(waitingApprovalBelongsToParent({ input: '{"__origin":{"parentRunId":"other"}}' }, "parent_1"), false);

    assert.deepEqual(resumeCheckpointEventQuery("run_1"), {
      sql: `SELECT data FROM run_events
      WHERE run_id = ? AND type = 'smithers.dispatched'
      ORDER BY created_at DESC LIMIT 1`,
      params: ["run_1"]
    });
    assert.equal(resumeCheckpointFromEvent({ data: '{"smithersRunId":42}' }), "42");
    assert.equal(resumeCheckpointFromEvent({ data: "{}" }), null);

    assert.deepEqual(runProgressMarkerQuery("run_1"), {
      sql: "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?",
      params: ["run_1"]
    });
  });

  it("extracts supervising parent ids from supported input shapes", () => {
    assert.equal(supervisingParentId({ __origin: { parentRunId: "parent_1" } }), "parent_1");
    assert.equal(supervisingParentId({ __supervisedChild: { parentRunId: "parent_2" } }), "parent_2");
    assert.equal(supervisingParentId({}), "");

    assert.deepEqual(supervisingParentStatusQuery("parent_1"), {
      sql: "SELECT status FROM runs WHERE id = ?",
      params: ["parent_1"]
    });
  });

  it("builds supervisor run lookup and meta update queries", () => {
    assert.deepEqual(supervisorRunStatusInputQuery("run_1"), {
      sql: "SELECT id, status, input FROM runs WHERE id = ?",
      params: ["run_1"]
    });
    assert.deepEqual(supervisorRunLookupQuery("run_1"), {
      sql: "SELECT * FROM runs WHERE id = ?",
      params: ["run_1"]
    });
    assert.deepEqual(supervisorMetaUpdateQuery({ runId: "run_1", meta: "{}" }), {
      sql: "UPDATE runs SET supervisor_meta=? WHERE id=?",
      params: ["{}", "run_1"]
    });
    assert.deepEqual(repairDispatchedUpdateQuery({ runId: "run_1", repairCount: 2, meta: "{}" }), {
      sql: "UPDATE runs SET repair_count=?, supervisor_meta=? WHERE id=?",
      params: [2, "{}", "run_1"]
    });
  });

  it("builds supervisor requeue update queries", () => {
    assert.deepEqual(resumeRunUpdateQuery({
      runId: "run_1",
      attempt: 3,
      meta: "{}",
      input: "{\"__resume\":true}",
      timestamp: "2026-01-01T00:00:00.000Z",
      observedStatus: "running"
    }), {
      sql: `UPDATE runs
        SET status='queued', runner_id=NULL, current_step='queued (resume from checkpoint)',
            error=NULL, attempt=$attempt, supervisor_meta=$meta, input=$input,
            completed_at=NULL, updated_at=$ts
      WHERE id=$id AND status=$observed`,
      params: {
        id: "run_1",
        attempt: 3,
        meta: "{}",
        input: "{\"__resume\":true}",
        ts: "2026-01-01T00:00:00.000Z",
        observed: "running"
      }
    });

    assert.deepEqual(freshRerunUpdateQuery({
      runId: "run_1",
      attempt: 4,
      meta: "{}",
      input: "{}",
      timestamp: "2026-01-01T00:00:00.000Z"
    }), {
      sql: `UPDATE runs
        SET status='queued', runner_id=NULL, current_step='queued (re-run after code repair)',
            error=NULL, attempt=$attempt, supervisor_meta=$meta, input=$input,
            completed_at=NULL, updated_at=$ts
      WHERE id=$id AND status='failed'`,
      params: {
        id: "run_1",
        attempt: 4,
        meta: "{}",
        input: "{}",
        ts: "2026-01-01T00:00:00.000Z"
      }
    });
  });

  it("builds supervisor reconcile scan queries", () => {
    assert.deepEqual(activeReapCandidatesQuery(), {
      sql: `SELECT runs.id,
            runs.runner_id,
            runs.status,
            runs.capability_slug,
            runs.input,
            runs.attempt,
            runs.repair_count,
            runs.supervisor_meta,
            runs.created_at,
            runs.assigned_at,
            runs.started_at,
            runners.last_heartbeat_at,
            (SELECT MAX(created_at) FROM run_events WHERE run_id = runs.id) AS last_event_at
       FROM runs
       LEFT JOIN runners ON runners.id = runs.runner_id
      WHERE runs.status IN ('assigned','running','waiting_approval')`,
      params: []
    });
    assert.deepEqual(failedRecoverableCandidatesQuery({ since: "2026-01-01T00:00:00.000Z", limit: "3" }), {
      sql: `SELECT id, runner_id, status, capability_slug, input, attempt, repair_count, supervisor_meta, error
       FROM runs
      WHERE status = 'failed' AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT ?`,
      params: ["2026-01-01T00:00:00.000Z", 3]
    });
  });
});
