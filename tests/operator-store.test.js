import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOperatorStore } from "../src/operatorStore.js";

const approvalRow = {
  id: "appr_1",
  run_id: "run_1",
  status: "pending",
  title: "Deploy?",
  description: "",
  requested_by: "workflow",
  payload: "{}",
  created_at: "2026-07-01T00:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  decision: null,
  comment: null
};

function createHarness({ oneRow = null, oneRows = null, allRows = [], runRecord = null } = {}) {
  const calls = [];
  const events = [];
  const runUpdates = [];
  const rows = oneRows ? [...oneRows] : null;
  const store = createOperatorStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows ? rows.shift() : oneRow;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_1`,
    now: () => "2026-07-01T00:00:00.000Z",
    addRunEvent: (...args) => events.push(args),
    getRun: () => runRecord,
    updateRun: (...args) => runUpdates.push(args)
  });
  return { calls, events, runUpdates, store };
}

describe("operator store", () => {
  it("records and reads alerts", () => {
    const { calls, store } = createHarness({
      oneRow: {
        id: "alert_1",
        kind: "update",
        level: "info",
        title: "Updated",
        message: "done",
        data: "{}",
        created_at: "2026-07-01T00:00:00.000Z"
      },
      allRows: [{
        id: "alert_1",
        kind: "update",
        level: "info",
        title: "Updated",
        message: "done",
        data: "{}",
        created_at: "2026-07-01T00:00:00.000Z"
      }]
    });

    assert.equal(store.recordAlert({ kind: "update", title: "Updated" }).id, "alert_1");
    assert.equal(store.listAlerts({ kind: "update", limit: 1 })[0].kind, "update");
    assert.equal(store.latestAlert("update").id, "alert_1");
    assert.equal(calls.filter((call) => call.fn === "run").length, 1);
  });

  it("creates artifacts and records the artifact-created run event", () => {
    const { events, store } = createHarness({
      oneRow: {
        id: "art_1",
        run_id: "run_1",
        name: "report.md",
        kind: "file",
        mime_type: "text/markdown",
        size_bytes: 10,
        path: "/tmp/report.md",
        metadata: "{}",
        created_at: "2026-07-01T00:00:00.000Z"
      }
    });

    const artifact = store.createArtifact({
      runId: "run_1",
      name: "report.md",
      mimeType: "text/markdown",
      sizeBytes: 10,
      path: "/tmp/report.md"
    });

    assert.equal(artifact.id, "art_1");
    assert.deepEqual(events[0], [
      "run_1",
      "artifact.created",
      "Artifact stored: report.md",
      { artifactId: "art_1" }
    ]);
  });

  it("lists artifacts and records audit entries", () => {
    const { calls, store } = createHarness({
      allRows: [{
        id: "aud_1",
        actor: "alice",
        action: "token.created",
        target: "tok_1",
        detail: "{}",
        created_at: "2026-07-01T00:00:00.000Z"
      }]
    });

    const audit = store.recordAudit("alice", "token.created", "tok_1", { scopes: ["api"] });
    assert.equal(audit.id, "aud_1");
    assert.equal(store.listAudit({ limit: 10 })[0].action, "token.created");
    assert.equal(calls.filter((call) => call.fn === "run").length, 1);
  });

  it("creates and lists approvals", () => {
    const { calls, events, store } = createHarness({
      oneRow: approvalRow,
      allRows: [approvalRow]
    });

    const approval = store.createApproval({
      runId: "run_1",
      title: "Deploy?",
      requestedBy: "workflow",
      payload: { environment: "prod" }
    });

    assert.equal(approval.id, "appr_1");
    assert.equal(store.getApproval("appr_1").title, "Deploy?");
    assert.equal(store.listApprovals("pending")[0].status, "pending");
    assert.deepEqual(events[0], [
      "run_1",
      "approval.requested",
      "Deploy?",
      { approvalId: "appr_1" }
    ]);
    assert.ok(calls.some((call) => call.fn === "run" && call.params.id === "appr_1"));
  });

  it("resolves approvals with audit, event, and waiting-run updates", () => {
    const approved = {
      ...approvalRow,
      status: "resolved",
      resolution: "approved",
      resolved_via: "human",
      decision: "approved",
      resolved_by: "alice",
      resolved_at: "2026-07-01T00:00:00.000Z"
    };
    const { events, runUpdates, store } = createHarness({
      oneRows: [approved],
      runRecord: { id: "run_1", status: "waiting_approval" }
    });

    const approval = store.resolveApproval("appr_1", "approved", "alice", "ship it");

    assert.equal(approval.status, "resolved");
    assert.equal(approval.resolution, "approved");
    assert.equal(approval.resolvedVia, "human");
    assert.deepEqual(events[0], [
      "run_1",
      "approval.approved",
      "Deploy?",
      { approvalId: "appr_1", decision: "approved", resolvedVia: "human", comment: "ship it" }
    ]);
    assert.deepEqual(runUpdates[0], [
      "run_1",
      {
        status: "queued",
        current_step: "approval granted; queued",
        completed_at: null
      }
    ]);
  });

  it("auto-queues legacy workflow-start approvals only", () => {
    const { calls, events, store } = createHarness({
      allRows: [
        {
          id: "appr_1",
          run_id: "run_1",
          payload: '{"kind":"run_start"}'
        },
        {
          id: "appr_2",
          run_id: "run_2",
          payload: '{"kind":"checkpoint"}'
        }
      ]
    });

    assert.equal(store.autoQueueLegacyRunStartApprovals(), 1);
    assert.equal(calls.filter((call) => call.fn === "run").length, 2);
    assert.deepEqual(events[0], [
      "run_1",
      "approval.auto_queued",
      "Workflow start approval auto-queued",
      { approvalId: "appr_1" }
    ]);
  });
});
