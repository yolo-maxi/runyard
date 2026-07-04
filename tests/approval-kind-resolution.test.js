import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const {
  createApproval,
  createRun,
  getApproval,
  getCapability,
  getRun,
  initDb,
  listApprovals,
  listRunEvents,
  resolveApproval,
  sweepSupersededApprovals,
  updateRun
} = await import("../src/db.js");
const { approvalKindFromPayload, approvalResolvedViaFromActor } = await import("../src/operatorRecords.js");

initDb();

function makeRun(status = "queued") {
  const run = createRun(getCapability("hello"), { name: "kind-test" });
  if (status !== run.status) updateRun(run.id, { status });
  return getRun(run.id);
}

describe("approval kind + honest resolution", () => {
  it("classifies kind from the payload conventions creators already use", () => {
    assert.equal(approvalKindFromPayload({ kind: "engine_approval" }), "workflow_gate");
    assert.equal(approvalKindFromPayload({ approvalKind: "engine_gate", approvalScope: "engine_node" }), "workflow_gate");
    assert.equal(approvalKindFromPayload({ kind: "checkpoint", approvalScope: "workflow_checkpoint" }), "workflow_gate");
    assert.equal(approvalKindFromPayload({ kind: "child_run_approval" }), "workflow_gate");
    assert.equal(approvalKindFromPayload({ kind: "supervisor_escalation" }), "escalation");
    assert.equal(approvalKindFromPayload({ kind: "side_effect" }), "side_effect");
    assert.equal(approvalKindFromPayload({ approvalScope: "post_run_hook" }), "side_effect");
    // Retired legacy kinds and ad-hoc cards are custom.
    assert.equal(approvalKindFromPayload({ kind: "run_start", approvalScope: "workflow_start" }), "custom");
    assert.equal(approvalKindFromPayload({}), "custom");
    assert.equal(approvalKindFromPayload(null), "custom");
  });

  it("stores kind at creation, once, instead of per-consumer payload archaeology", () => {
    const gate = createApproval({
      title: "Engine approval: hello · ship-gate",
      payload: { kind: "engine_approval", smithersRunId: "run_sm_k", nodeId: "ship-gate" }
    });
    assert.equal(getApproval(gate.id).kind, "workflow_gate");

    const escalation = createApproval({
      title: "Supervisor escalation: hello",
      payload: { kind: "supervisor_escalation", escalation: "three_strike" }
    });
    assert.equal(getApproval(escalation.id).kind, "escalation");

    const adHoc = createApproval({ title: "Ad hoc question" });
    assert.equal(getApproval(adHoc.id).kind, "custom");
  });

  it("infers resolved_via from historical actor strings (migration backfill contract)", () => {
    assert.equal(approvalResolvedViaFromActor("system:approval-timer"), "fallback_timer");
    assert.equal(approvalResolvedViaFromActor("engine:cli"), "engine");
    assert.equal(approvalResolvedViaFromActor("system:auto-queue"), "policy");
    assert.equal(approvalResolvedViaFromActor("system:run-terminal"), "system");
    assert.equal(approvalResolvedViaFromActor("alice"), "human");
    assert.equal(approvalResolvedViaFromActor("telegram:fran"), "human");
    assert.equal(approvalResolvedViaFromActor(""), "human");
  });

  it("keeps changes_requested honest: status resolved, resolution changes_requested", () => {
    const run = makeRun("waiting_approval");
    const approval = createApproval({ runId: run.id, title: "Needs more detail" });
    resolveApproval(approval.id, "changes_requested", "operator", "please add a rollout plan");

    const resolved = getApproval(approval.id);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "changes_requested");
    assert.equal(resolved.resolvedVia, "human");
    // Legacy decision column still mirrors the human decision for old readers.
    assert.equal(resolved.decision, "changes_requested");
    // Nothing about this row claims "rejected" anymore.
    assert.ok(!listApprovals("rejected").some((item) => item.id === approval.id));
    assert.ok(!listApprovals("pending").some((item) => item.id === approval.id));
    // A human saying "not like this" cancels the run — it never fails it.
    assert.equal(getRun(run.id).status, "cancelled");
  });

  it("supersedes pending cards on terminal runs, and only those", () => {
    const deadRun = makeRun("failed");
    const stale = createApproval({
      runId: deadRun.id,
      title: "Supervisor escalation: hello",
      payload: { kind: "supervisor_escalation", escalation: "max_attempts" }
    });

    const heldRun = makeRun("waiting_approval");
    const blocking = createApproval({ runId: heldRun.id, title: "Blocking gate" });

    const runLess = createApproval({ title: "No linked run" });

    const swept = sweepSupersededApprovals();
    assert.deepEqual(
      swept.map((entry) => entry.id),
      [stale.id]
    );

    const superseded = getApproval(stale.id);
    assert.equal(superseded.status, "resolved");
    assert.equal(superseded.resolution, "superseded");
    assert.equal(superseded.resolvedVia, "system");
    assert.equal(superseded.resolvedBy, "system:run-terminal");
    assert.equal(superseded.decision, null);
    assert.match(superseded.comment, /ended \(failed\)/);
    // The run itself is untouched — superseding a card never edits history.
    assert.equal(getRun(deadRun.id).status, "failed");
    const events = listRunEvents(deadRun.id).map((event) => event.type);
    assert.ok(events.includes("approval.superseded"), `events: ${events.join(", ")}`);

    // Cards that still ask a live question are never swept.
    assert.equal(getApproval(blocking.id).status, "pending");
    assert.equal(getApproval(runLess.id).status, "pending");
    assert.equal(getRun(heldRun.id).status, "waiting_approval");

    // Idempotent: a second sweep finds nothing.
    assert.deepEqual(sweepSupersededApprovals(), []);
  });

  it("migrates an old-schema database in one guarded pass", () => {
    const migrationTemp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-migration-"));
    const dbPath = path.join(migrationTemp, "test.sqlite");

    // Build the pre-kind/resolution approvals table exactly as it shipped,
    // with representative rows: a pending legacy run_start card holding a
    // waiting run, resolved rows in every historical shape, and pending
    // engine/escalation cards that must survive untouched.
    const fixture = new DatabaseSync(dbPath);
    fixture.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        capability_slug TEXT NOT NULL,
        capability_name TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        runner_id TEXT,
        status TEXT NOT NULL,
        current_step TEXT NOT NULL DEFAULT '',
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        assigned_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT 'workflow',
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        decision TEXT,
        comment TEXT,
        timeout_at TEXT,
        fallback TEXT,
        timer_state TEXT NOT NULL DEFAULT '',
        timer_elapsed_at TEXT
      );
      INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, status, current_step, created_at, updated_at)
        VALUES ('run_legacy', 'cap_1', 'hello', 'Hello', 1, 'waiting_approval', 'waiting for approval', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO approvals (id, run_id, status, title, payload, created_at)
        VALUES ('appr_legacy', 'run_legacy', 'pending', 'Approve workflow start', '{"kind":"run_start","approvalScope":"workflow_start"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO approvals (id, status, title, payload, created_at, resolved_at, resolved_by, decision)
        VALUES ('appr_cr', 'rejected', 'Old changes-requested', '{}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'operator', 'changes_requested');
      INSERT INTO approvals (id, status, title, payload, created_at, resolved_at, resolved_by, decision)
        VALUES ('appr_timer', 'approved', 'Old timer fallback', '{}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'system:approval-timer', 'approved');
      INSERT INTO approvals (id, status, title, payload, created_at, resolved_at, resolved_by)
        VALUES ('appr_bare', 'rejected', 'Old decisionless reject', '{}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'bob');
      INSERT INTO approvals (id, run_id, status, title, payload, created_at)
        VALUES ('appr_engine', NULL, 'pending', 'Engine approval: hello · gate', '{"kind":"engine_approval","nodeId":"gate"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO approvals (id, run_id, status, title, payload, created_at)
        VALUES ('appr_esc', NULL, 'pending', 'Supervisor escalation: hello', '{"kind":"supervisor_escalation"}', '2026-01-01T00:00:00.000Z');
    `);
    fixture.close();

    const childScript = `
      const { initDb, listApprovals, getRun } = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
      initDb();
      initDb(); // idempotent: the guarded backfill must not run twice
      const approvals = Object.fromEntries(listApprovals().map((approval) => [approval.id, approval]));
      console.log(JSON.stringify({ approvals, legacyRun: getRun("run_legacy") }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
      env: {
        ...process.env,
        SMITHERS_HUB_ROOT: process.cwd(),
        SMITHERS_HUB_DATA_DIR: migrationTemp,
        SMITHERS_HUB_DB: dbPath,
        SMITHERS_HUB_SESSION_SECRET: "test-secret",
        SMITHERS_HUB_BOOTSTRAP_TOKEN: "shub_migration_token"
      },
      encoding: "utf8"
    });
    const { approvals, legacyRun } = JSON.parse(output.trim().split("\n").pop());

    // Legacy pending run_start card auto-queued one final time, honestly.
    assert.equal(approvals.appr_legacy.status, "resolved");
    assert.equal(approvals.appr_legacy.resolution, "approved");
    assert.equal(approvals.appr_legacy.resolvedVia, "policy");
    assert.equal(approvals.appr_legacy.resolvedBy, "system:auto-queue");
    assert.equal(approvals.appr_legacy.kind, "custom");
    assert.equal(legacyRun.status, "queued");

    // changes_requested un-collapsed from its old rejected status.
    assert.equal(approvals.appr_cr.status, "resolved");
    assert.equal(approvals.appr_cr.resolution, "changes_requested");
    assert.equal(approvals.appr_cr.resolvedVia, "human");

    // Timer-resolved and decisionless rows get honest resolution + via.
    assert.equal(approvals.appr_timer.resolution, "approved");
    assert.equal(approvals.appr_timer.resolvedVia, "fallback_timer");
    assert.equal(approvals.appr_bare.status, "resolved");
    assert.equal(approvals.appr_bare.resolution, "rejected");
    assert.equal(approvals.appr_bare.resolvedVia, "human");

    // Pending cards keep waiting, now with an explicit kind.
    assert.equal(approvals.appr_engine.status, "pending");
    assert.equal(approvals.appr_engine.kind, "workflow_gate");
    assert.equal(approvals.appr_esc.status, "pending");
    assert.equal(approvals.appr_esc.kind, "escalation");
  });
});
