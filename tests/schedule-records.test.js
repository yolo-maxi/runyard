import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeScheduleNext,
  dueSchedulesQuery,
  normalizeSchedule,
  scheduleClaimDecision,
  scheduleClaimUpdateQuery,
  scheduleCreateRecord,
  scheduleDeleteQuery,
  scheduleFireResultUpdateQuery,
  scheduleInsertQuery,
  scheduleListQuery,
  scheduleLookupQuery,
  scheduleUpdateQuery,
  scheduleUpdateValues,
  SCHEDULE_TIMEZONE_DEFAULT
} from "../src/scheduleRecords.js";

describe("schedule record helpers", () => {
  it("normalizes stored schedule rows", () => {
    assert.deepEqual(normalizeSchedule({
      id: "sched_1",
      name: "Nightly",
      description: null,
      capability_slug: "research",
      cron: "0 0 * * *",
      timezone: "",
      input: '{"prompt":"status"}',
      enabled: 1,
      run_at: null,
      next_run_at: "2026-07-01T00:00:00.000Z",
      last_run_at: null,
      last_run_id: null,
      last_status: null,
      created_by: null,
      created_at: "2026-06-30T00:00:00.000Z",
      updated_at: "2026-06-30T00:00:00.000Z"
    }), {
      id: "sched_1",
      name: "Nightly",
      description: "",
      capabilitySlug: "research",
      cron: "0 0 * * *",
      timezone: SCHEDULE_TIMEZONE_DEFAULT,
      input: { prompt: "status" },
      enabled: true,
      kind: "cron",
      runAt: null,
      nextRunAt: "2026-07-01T00:00:00.000Z",
      lastRunAt: null,
      lastRunId: null,
      lastStatus: "",
      createdBy: "",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z"
    });
    assert.equal(normalizeSchedule(null), null);
  });

  it("keeps malformed stored input non-fatal", () => {
    const schedule = normalizeSchedule({
      id: "sched_bad",
      name: "Bad input",
      capability_slug: "research",
      cron: "",
      input: "{bad",
      enabled: 0
    });

    assert.deepEqual(schedule.input, {});
    assert.equal(schedule.enabled, false);
    assert.equal(schedule.kind, "once");
  });

  it("computes next fire instants for cron and one-shot schedules", () => {
    const fromIso = "2026-06-22T10:15:30.000Z";
    assert.equal(
      computeScheduleNext({ cron: "*/5 * * * *", timezone: "UTC" }, fromIso),
      "2026-06-22T10:20:00.000Z"
    );
    assert.equal(
      computeScheduleNext({ runAt: "2030-01-01T00:00:00.000Z" }, fromIso),
      "2030-01-01T00:00:00.000Z"
    );
    assert.equal(computeScheduleNext({ runAt: "2000-01-01T00:00:00.000Z" }, fromIso), null);
    assert.equal(computeScheduleNext({}, fromIso), null);
  });

  it("builds schedule creation records with normalized timing fields", () => {
    const record = scheduleCreateRecord({
      id: "sched_1",
      input: {
        name: "Once",
        capabilitySlug: "hello",
        input: { goal: "ship" },
        runAt: "2030-01-01T00:00:00.000Z",
        createdBy: "admin"
      },
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.id, "sched_1");
    assert.equal(record.cron, "");
    assert.equal(record.timezone, SCHEDULE_TIMEZONE_DEFAULT);
    assert.equal(record.input, '{"goal":"ship"}');
    assert.equal(record.enabled, 1);
    assert.equal(record.next_run_at, "2030-01-01T00:00:00.000Z");
    assert.equal(record.created_by, "admin");
  });

  it("builds schedule insert, lookup, and list queries", () => {
    assert.deepEqual(scheduleInsertQuery(), {
      sql: `INSERT INTO schedules
     (id, name, description, capability_slug, cron, timezone, input, enabled, run_at, next_run_at,
      last_run_at, last_run_id, last_status, created_by, created_at, updated_at)
     VALUES ($id, $name, $description, $capability_slug, $cron, $timezone, $input, $enabled, $run_at, $next_run_at,
      $last_run_at, $last_run_id, $last_status, $created_by, $created_at, $updated_at)`
    });
    assert.deepEqual(scheduleLookupQuery("sched_1"), {
      sql: "SELECT * FROM schedules WHERE id = ?",
      params: ["sched_1"]
    });
    assert.deepEqual(scheduleListQuery(), {
      sql: "SELECT * FROM schedules ORDER BY created_at DESC",
      params: []
    });
    assert.deepEqual(scheduleListQuery({ includeDisabled: false }), {
      sql: "SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC",
      params: []
    });
  });

  it("builds schedule update values and recomputes next run", () => {
    const values = scheduleUpdateValues({
      name: "Old",
      description: "",
      capability_slug: "hello",
      cron: "",
      timezone: "UTC",
      input: "{}",
      enabled: 1,
      run_at: null
    }, {
      name: "New",
      cron: "*/5 * * * *",
      input: { goal: "later" }
    }, "2026-06-22T10:15:30.000Z");

    assert.deepEqual(values, [
      "New",
      "",
      "hello",
      "*/5 * * * *",
      "UTC",
      '{"goal":"later"}',
      1,
      null,
      "2026-06-22T10:20:00.000Z",
      "2026-06-22T10:15:30.000Z"
    ]);
  });

  it("builds schedule update, delete, and due-list queries", () => {
    const values = ["New", "", "hello", "", "UTC", "{}", 1, null, null, "2026-01-01T00:00:00.000Z"];
    assert.deepEqual(scheduleUpdateQuery({ idValue: "sched_1", values }), {
      sql: `UPDATE schedules SET name=?, description=?, capability_slug=?, cron=?, timezone=?, input=?, enabled=?,
       run_at=?, next_run_at=?, updated_at=? WHERE id=?`,
      params: [...values, "sched_1"]
    });
    assert.deepEqual(scheduleDeleteQuery("sched_1"), {
      sql: "DELETE FROM schedules WHERE id = ?",
      params: ["sched_1"]
    });
    assert.deepEqual(dueSchedulesQuery("2026-01-01T00:00:00.000Z"), {
      sql: "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      params: ["2026-01-01T00:00:00.000Z"]
    });
  });

  it("decides due schedule claims without touching persistence", () => {
    assert.deepEqual(scheduleClaimDecision(null, "x", "2026-01-01T00:00:00.000Z"), {
      ok: false,
      reason: "not_found"
    });
    assert.deepEqual(scheduleClaimDecision({ enabled: 0 }, "x", "2026-01-01T00:00:00.000Z"), {
      ok: false,
      reason: "disabled"
    });
    assert.deepEqual(scheduleClaimDecision({ enabled: 1, next_run_at: "a" }, "b", "2026-01-01T00:00:00.000Z"), {
      ok: false,
      reason: "raced"
    });
    assert.deepEqual(scheduleClaimDecision({
      enabled: 1,
      cron: "",
      run_at: "2026-01-01T00:00:00.000Z",
      next_run_at: "2026-01-01T00:00:00.000Z"
    }, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), {
      ok: true,
      nextRunAt: null,
      enabled: 0
    });
  });

  it("builds schedule claim and fire-result update queries", () => {
    assert.deepEqual(
      scheduleClaimUpdateQuery({
        idValue: "sched_1",
        expectedNextRunAt: "2026-01-01T00:00:00.000Z",
        decision: { nextRunAt: "2026-01-02T00:00:00.000Z", enabled: 1 },
        nowIso: "2026-01-01T00:00:00.000Z"
      }),
      {
        sql: "UPDATE schedules SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1",
        params: [
          "2026-01-02T00:00:00.000Z",
          1,
          "2026-01-01T00:00:00.000Z",
          "sched_1",
          "2026-01-01T00:00:00.000Z"
        ]
      }
    );
    assert.deepEqual(
      scheduleFireResultUpdateQuery({
        idValue: "sched_1",
        runId: "",
        status: "failed",
        firedAtIso: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z"
      }),
      {
        sql: "UPDATE schedules SET last_run_at = ?, last_run_id = ?, last_status = ?, updated_at = ? WHERE id = ?",
        params: ["2026-01-01T00:00:00.000Z", null, "failed", "2026-01-01T00:00:01.000Z", "sched_1"]
      }
    );
  });
});
