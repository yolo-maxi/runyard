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
  runReapReason
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

  it("classifies reap reasons while leaving waiting approvals and supervised waits alone", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");

    assert.equal(runReapReason({ status: "waiting_approval" }, { nowMs }), null);
    assert.equal(runReapReason({
      id: "parent",
      status: "running",
      capability_slug: "run-smithers",
      last_event_at: "2026-01-01T00:00:00.000Z"
    }, {
      stallMs: 5 * 60_000,
      nowMs,
      hasWaitingApprovalSupervisedChild: () => true
    }), null);

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

    // A run-smithers parent whose child waits for approval is exempt from the
    // max-runtime backstop too, not just the stall window.
    assert.equal(runReapReason({ ...staleRunningRow, capability_slug: "run-smithers" }, {
      maxMs: 5 * 60_000,
      nowMs,
      hasWaitingApprovalSupervisedChild: () => true
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
});
