import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ageMs,
  buildRunFilterClause,
  capabilityVersionsFromRunsQuery,
  normalizeCapabilityVersionFromRun,
  runBackstopExceeded,
  runCountQuery,
  runListQuery,
  runReapReason,
  runnerLifecycleProtectsFromStall,
  runnerLifecycleState,
  runnerLifecycleTerminalReconciliation
} from "../src/runQueryRecords.js";

describe("run query record helpers", () => {
  it("builds aligned run filter clauses and strips LIKE wildcards from search", () => {
    const result = buildRunFilterClause({
      status: "queued",
      q: "ship_%done",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      cursor: "2026-01-15T00:00:00.000Z",
      capabilitySlugs: ["hello", "hello", "audit", ""],
      visibleRunWhere: "visible = 1"
    });

    assert.match(result.clause, /^WHERE visible = 1 AND capability_slug IN \(\?, \?\)/);
    assert.deepEqual(result.params.slice(0, 2), ["hello", "audit"]);
    assert.equal(result.params.at(-1), "%shipdone%");
  });

  it("omits internal-run visibility filters when includeInternal is true", () => {
    assert.deepEqual(buildRunFilterClause({ includeInternal: true, visibleRunWhere: "visible = 1" }), {
      clause: "",
      params: []
    });
  });

  it("builds run list and count queries from shared filters", () => {
    assert.deepEqual(runListQuery({
      status: "queued",
      q: "ship",
      limit: 25,
      visibleRunWhere: "visible = 1"
    }), {
      sql: "SELECT * FROM runs WHERE visible = 1 AND status = ? AND (capability_name LIKE ? OR capability_slug LIKE ? OR id LIKE ? OR current_step LIKE ? OR COALESCE(error,'') LIKE ?) ORDER BY created_at DESC LIMIT ?",
      params: ["queued", "%ship%", "%ship%", "%ship%", "%ship%", "%ship%", 25]
    });

    assert.deepEqual(runCountQuery({
      capabilitySlugs: ["alpha", "beta"],
      includeInternal: true,
      visibleRunWhere: "visible = 1"
    }), {
      sql: "SELECT COUNT(*) AS count FROM runs WHERE capability_slug IN (?, ?)",
      params: ["alpha", "beta"]
    });
  });

  it("builds capability version aggregate queries", () => {
    assert.deepEqual(capabilityVersionsFromRunsQuery("deploy"), {
      sql: `SELECT capability_sha AS sha,
            COUNT(*) AS runCount,
            MIN(created_at) AS firstSeenAt,
            MAX(created_at) AS lastSeenAt
       FROM runs
      WHERE capability_slug = ?
        AND capability_sha IS NOT NULL
        AND capability_sha <> ''
      GROUP BY capability_sha
      ORDER BY lastSeenAt DESC`,
      params: ["deploy"]
    });
  });

  it("normalizes capability version aggregate rows", () => {
    assert.deepEqual(normalizeCapabilityVersionFromRun({
      sha: "abc123",
      runCount: 3,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z"
    }), {
      sha: "abc123",
      runCount: 3,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z"
    });
  });

  it("computes run age and max-runtime backstop state", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
    assert.equal(ageMs("", nowMs), Number.POSITIVE_INFINITY);
    assert.equal(ageMs("bad-date", nowMs), Number.POSITIVE_INFINITY);
    assert.equal(ageMs("2026-01-01T00:00:00.000Z", nowMs), 10 * 60_000);
    assert.equal(runBackstopExceeded({ started_at: "2026-01-01T00:00:00.000Z" }, 5 * 60_000, nowMs), true);
    assert.equal(runBackstopExceeded({ started_at: "2026-01-01T00:09:00.000Z" }, 5 * 60_000, nowMs), false);
  });

  it("classifies reap reasons while leaving waiting approvals alone", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");

    assert.equal(runReapReason({ status: "waiting_approval" }, { nowMs }), null);

    assert.equal(runReapReason({
      status: "running",
      runner_id: "runner_1",
      last_heartbeat_at: "2026-01-01T00:00:00.000Z"
    }, {
      runnerOfflineMs: 5 * 60_000,
      nowMs
    }).reason, "runner_offline");

    assert.equal(runReapReason({
      status: "running",
      created_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:00:00.000Z"
    }, {
      stallMs: 5 * 60_000,
      nowMs
    }).reason, "run_stalled");

    assert.equal(runReapReason({
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z"
    }, {
      maxMs: 5 * 60_000,
      nowMs
    }).reason, "max_runtime");
  });

  it("never reaps an approval-held run for age: pending approvals block stall and max_runtime", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
    const staleRunningRow = {
      id: "run_1",
      status: "running",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:00:00.000Z"
    };

    // A run with its own unresolved approval card is neither stalled nor timed out.
    assert.equal(runReapReason(staleRunningRow, {
      stallMs: 5 * 60_000,
      maxMs: 5 * 60_000,
      nowMs,
      hasPendingApproval: () => true
    }), null);

    // Once the approval is resolved (no longer pending), age-based reaping resumes.
    assert.equal(runReapReason(staleRunningRow, {
      stallMs: 5 * 60_000,
      nowMs,
      hasPendingApproval: () => false
    }).reason, "run_stalled");

    // A dead runner still wins over an approval hold: heartbeat expiry is an
    // infra fact the supervisor adjudicates (resume/requeue), not a timeout.
    assert.equal(runReapReason({
      ...staleRunningRow,
      runner_id: "runner_1",
      last_heartbeat_at: "2026-01-01T00:00:00.000Z"
    }, {
      runnerOfflineMs: 5 * 60_000,
      nowMs,
      hasPendingApproval: () => true
    }).reason, "runner_offline");
  });

  it("never stall- or deadline-reaps a run held by an engine-level approval wait", () => {
    const nowMs = Date.parse("2026-01-01T01:00:00.000Z");
    const engineHeldRow = {
      id: "run_engine",
      status: "running",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:00:00.000Z"
    };
    const holds = { hasEngineApprovalWait: (id) => id === "run_engine" };

    assert.equal(runReapReason(engineHeldRow, { stallMs: 5 * 60_000, nowMs, ...holds }), null);
    assert.equal(runReapReason(engineHeldRow, { maxMs: 5 * 60_000, nowMs, ...holds }), null);

    // Without the hold the same quiet run is reaped — the exemption is the only difference.
    assert.equal(runReapReason(engineHeldRow, { stallMs: 5 * 60_000, nowMs }).reason, "run_stalled");

    // A dead runner still wins over an engine approval hold too.
    assert.equal(runReapReason({
      ...engineHeldRow,
      runner_id: "runner_1",
      last_heartbeat_at: "2026-01-01T00:00:00.000Z"
    }, {
      runnerOfflineMs: 5 * 60_000,
      nowMs,
      ...holds
    }).reason, "runner_offline");
  });

  it("does not reap an event-quiet run while the runner reports a fresh active Smithers process", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
    const quietActive = {
      id: "run_quiet",
      status: "running",
      runner_id: "runner_1",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:00:00.000Z",
      last_heartbeat_at: "2026-01-01T00:00:00.000Z",
      runner_state: JSON.stringify({
        smithersRunId: "run-1784909133764",
        phase: "active",
        engineState: "running",
        observedAt: "2026-01-01T00:09:30.000Z"
      })
    };

    assert.equal(runnerLifecycleProtectsFromStall(quietActive, {
      stallMs: 5 * 60_000,
      runnerOfflineMs: 5 * 60_000,
      nowMs
    }), true);
    assert.equal(runReapReason(quietActive, {
      stallMs: 5 * 60_000,
      runnerOfflineMs: 5 * 60_000,
      nowMs
    }), null);
  });

  it("reconciles an old terminal Smithers success observation instead of emitting a stale failure", () => {
    const nowMs = Date.parse("2026-01-01T00:30:00.000Z");
    const terminal = {
      id: "run_terminal",
      status: "running",
      runner_id: "runner_1",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:10:00.000Z",
      last_heartbeat_at: "2026-01-01T00:10:00.000Z",
      runner_state: JSON.stringify({
        smithersRunId: "run-1784909133764",
        phase: "terminal",
        engineState: "succeeded",
        observedAt: "2026-01-01T00:11:16.000Z",
        terminalObservedAt: "2026-01-01T00:11:16.000Z",
        branch: "runyard/implement-change-gated/master/run_0dc99254d15bf40159ed",
        commit: "bda518d554d762a7217a3ca988916cab64dc3f1f"
      })
    };

    assert.deepEqual(runnerLifecycleState(terminal), {
      smithersRunId: "run-1784909133764",
      phase: "terminal",
      engineState: "succeeded",
      observedAt: "2026-01-01T00:11:16.000Z",
      terminalObservedAt: "2026-01-01T00:11:16.000Z",
      branch: "runyard/implement-change-gated/master/run_0dc99254d15bf40159ed",
      commit: "bda518d554d762a7217a3ca988916cab64dc3f1f"
    });
    const reconciliation = runnerLifecycleTerminalReconciliation(terminal, {
      stallMs: 5 * 60_000,
      nowMs
    });
    assert.equal(reconciliation.status, "succeeded");
    assert.equal(reconciliation.reason, "runner_terminal_reconciled");
    assert.equal(reconciliation.output.branch, "runyard/implement-change-gated/master/run_0dc99254d15bf40159ed");
    assert.equal(reconciliation.output.commit, "bda518d554d762a7217a3ca988916cab64dc3f1f");
    assert.equal(runReapReason(terminal, {
      stallMs: 5 * 60_000,
      runnerOfflineMs: 5 * 60_000,
      maxMs: 5 * 60_000,
      nowMs
    }).status, "succeeded");

    assert.equal(runReapReason({
      ...terminal,
      runner_state: JSON.stringify({
        ...JSON.parse(terminal.runner_state),
        observedAt: "2026-01-01T00:29:30.000Z",
        terminalObservedAt: "2026-01-01T00:29:30.000Z"
      })
    }, {
      stallMs: 5 * 60_000,
      runnerOfflineMs: 5 * 60_000,
      maxMs: 5 * 60_000,
      nowMs
    }), null);
  });

  it("still reaps a genuinely stalled process when runner lifecycle evidence is stale", () => {
    const nowMs = Date.parse("2026-01-01T00:30:00.000Z");
    assert.equal(runReapReason({
      id: "run_stalled",
      status: "running",
      runner_id: "runner_1",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      last_event_at: "2026-01-01T00:00:00.000Z",
      last_heartbeat_at: "2026-01-01T00:29:50.000Z",
      runner_state: JSON.stringify({
        smithersRunId: "run-stale",
        phase: "active",
        engineState: "running",
        observedAt: "2026-01-01T00:00:30.000Z"
      })
    }, {
      stallMs: 5 * 60_000,
      runnerOfflineMs: 5 * 60_000,
      nowMs
    }).reason, "run_stalled");
  });
});
