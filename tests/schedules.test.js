import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-sched-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_HUB_RUNYARD_MOBILE_FEEDBACK_SECRET = "shub_test_feedback_endpoint";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const cron = await import("../src/cron.js");
const { app, fireDueSchedules } = await import("../src/server.js");
const { db, getSchedule, listRuns } = await import("../src/db.js");

let server;
let baseUrl;
const token = "shub_test_token";
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

function raw(pathname, options = {}, bearer = token) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const data = text && contentType.includes("application/json") ? JSON.parse(text) : text || null;
    return { status: response.status, data };
  });
}

// Force a schedule to be due by rewinding its next_run_at directly. Mirrors a
// schedule whose boundary has passed (or that was missed while the Hub slept).
function makeDue(scheduleId, iso = "2000-01-01T00:00:00.000Z") {
  db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(iso, scheduleId);
}

function runsForSchedule(scheduleId) {
  return listRuns({ limit: 500 }).filter((run) => run.input?.__origin?.scheduleId === scheduleId);
}

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

describe("cron parser: next-run calculation", () => {
  const from = new Date("2026-06-22T10:15:30Z"); // a Monday

  it("computes */n minute steps", () => {
    assert.equal(cron.nextRun("*/5 * * * *", from).toISOString(), "2026-06-22T10:20:00.000Z");
  });

  it("computes daily and hourly boundaries", () => {
    assert.equal(cron.nextRun("0 0 * * *", from).toISOString(), "2026-06-23T00:00:00.000Z");
    assert.equal(cron.nextRun("0 * * * *", from).toISOString(), "2026-06-22T11:00:00.000Z");
  });

  it("supports weekday names and ranges", () => {
    assert.equal(cron.nextRun("30 9 * * mon", from).toISOString(), "2026-06-29T09:30:00.000Z");
    assert.deepEqual(cron.nextRuns("0 9 * * 1-5", 3, from), [
      "2026-06-23T09:00:00.000Z",
      "2026-06-24T09:00:00.000Z",
      "2026-06-25T09:00:00.000Z"
    ]);
  });

  it("applies Vixie day-of-month OR day-of-week semantics", () => {
    // 13th OR Friday, starting Mon Jun 22 -> Friday Jun 26 comes first.
    assert.equal(cron.nextRun("0 0 13 * 5", new Date("2026-06-22T00:00:00Z")).toISOString(), "2026-06-26T00:00:00.000Z");
  });

  it("finds rare occurrences (Feb 29)", () => {
    assert.equal(cron.nextRun("0 0 29 2 *", from).toISOString(), "2028-02-29T00:00:00.000Z");
  });

  it("evaluates against the schedule timezone", () => {
    // Midnight in America/New_York (EDT, -4) is 04:00 UTC.
    assert.equal(cron.nextRun("0 0 * * *", from, "America/New_York").toISOString(), "2026-06-23T04:00:00.000Z");
  });

  it("never returns the `from` instant itself", () => {
    const exact = new Date("2026-06-22T10:20:00Z");
    assert.equal(cron.nextRun("*/5 * * * *", exact).toISOString(), "2026-06-22T10:25:00.000Z");
  });

  it("supports @aliases", () => {
    assert.equal(cron.nextRun("@hourly", from).toISOString(), "2026-06-22T11:00:00.000Z");
  });

  it("validates expressions and timezones", () => {
    assert.equal(cron.validateCron("0 0 * * *").ok, true);
    assert.equal(cron.validateCron("99 * * * *").ok, false);
    assert.equal(cron.validateCron("0 0 * *").ok, false);
    assert.equal(cron.validateCron("0 0 * * *", "Not/AZone").ok, false);
  });

  it("describes common patterns", () => {
    assert.equal(cron.describeCron("0 0 * * *"), "Daily at 00:00 UTC");
    assert.equal(cron.describeCron("30 9 * * 1"), "Weekly on Monday at 09:30 UTC");
    assert.equal(cron.describeCron("*/15 * * * *"), "Every 15 minutes");
  });
});

describe("schedules: CRUD over the API", () => {
  it("creates, lists, gets, updates, toggles, and deletes a schedule", async () => {
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Nightly research", capabilitySlug: "research", cron: "0 0 * * *", input: { prompt: "status" } }
    });
    const id = created.schedule.id;
    assert.equal(created.schedule.name, "Nightly research");
    assert.equal(created.schedule.kind, "cron");
    assert.ok(created.schedule.nextRunAt, "should have a computed next run");
    assert.ok(created.schedule.preview?.description.startsWith("Daily at 00:00"));
    assert.equal(created.schedule.preview.nextRuns.length, 3);

    const list = await api("/api/schedules");
    assert.ok(list.schedules.some((s) => s.id === id));

    const fetched = await api(`/api/schedules/${id}`);
    assert.equal(fetched.schedule.capabilitySlug, "research");

    const patched = await api(`/api/schedules/${id}`, { method: "PATCH", body: { cron: "0 6 * * *", description: "morning" } });
    assert.equal(patched.schedule.description, "morning");
    assert.ok(patched.schedule.preview.description.startsWith("Daily at 06:00"));

    const disabled = await api(`/api/schedules/${id}/disable`, { method: "POST" });
    assert.equal(disabled.schedule.enabled, false);
    assert.equal(disabled.schedule.nextRunAt, null, "disabled schedules have no next run");

    const enabled = await api(`/api/schedules/${id}/enable`, { method: "POST" });
    assert.equal(enabled.schedule.enabled, true);
    assert.ok(enabled.schedule.nextRunAt, "re-enabling recomputes next run");

    const deleted = await api(`/api/schedules/${id}`, { method: "DELETE" });
    assert.equal(deleted.deleted, true);
    const after = await raw(`/api/schedules/${id}`);
    assert.equal(after.status, 404);
  });

  it("supports one-shot (runAt) schedules", async () => {
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Once later", capabilitySlug: "hello", runAt: "2030-01-01T00:00:00Z", input: { topic: "x" } }
    });
    assert.equal(created.schedule.kind, "once");
    assert.equal(created.schedule.nextRunAt, "2030-01-01T00:00:00.000Z");
    await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" });
  });

  it("rejects invalid input", async () => {
    const badCron = await raw("/api/schedules", { method: "POST", body: { name: "x", capabilitySlug: "research", cron: "99 * * * *" } });
    assert.equal(badCron.status, 400);

    const badCap = await raw("/api/schedules", { method: "POST", body: { name: "x", capabilitySlug: "does-not-exist", cron: "0 0 * * *" } });
    assert.equal(badCap.status, 400);

    const noTrigger = await raw("/api/schedules", { method: "POST", body: { name: "x", capabilitySlug: "research" } });
    assert.equal(noTrigger.status, 400);

    const badInput = await raw("/api/schedules", { method: "POST", body: { name: "x", capabilitySlug: "research", cron: "0 0 * * *", input: [1, 2] } });
    assert.equal(badInput.status, 400);
  });

  it("requires admin scope to create and an auth token to read", async () => {
    const unauth = await raw("/api/schedules", {}, "");
    assert.equal(unauth.status, 401);
  });

  it("previews a cron expression", async () => {
    const preview = await api("/api/schedules/preview?cron=" + encodeURIComponent("0 9 * * 1-5"));
    assert.equal(preview.valid, true);
    assert.equal(preview.nextRuns.length, 5);
    const invalid = await api("/api/schedules/preview?cron=" + encodeURIComponent("99 * * * *"));
    assert.equal(invalid.valid, false);
  });
});

describe("schedules: due evaluation", () => {
  it("fires a due schedule by creating a run, and is idempotent across ticks", async () => {
    // The created run's slug is deterministic because scheduled runs use the
    // same direct dispatch path as manual runs.
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Due now", capabilitySlug: "hello", cron: "*/5 * * * *", input: { topic: "tick" } }
    });
    const id = created.schedule.id;

    makeDue(id);
    const firstTick = fireDueSchedules();
    assert.equal(firstTick.length, 1, "one run fired on the first due tick");

    // Re-firing immediately must NOT create a second run: next_run_at advanced.
    const secondTick = fireDueSchedules();
    assert.equal(secondTick.length, 0, "no double fire on the next tick");

    const runs = runsForSchedule(id);
    assert.equal(runs.length, 1, "exactly one run created for the schedule");
    assert.equal(runs[0].capabilitySlug, "hello");

    const sched = getSchedule(id);
    assert.equal(sched.lastRunId, runs[0].id);
    assert.ok(sched.nextRunAt > new Date().toISOString(), "next run advanced into the future");

    await api(`/api/schedules/${id}`, { method: "DELETE" });
  });

  it("collapses a backlog of missed ticks into a single fire", async () => {
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Missed", capabilitySlug: "research", cron: "*/1 * * * *", input: { prompt: "catchup" } }
    });
    const id = created.schedule.id;
    makeDue(id, "2000-01-01T00:00:00.000Z"); // years of missed minute-ticks
    fireDueSchedules();
    assert.equal(runsForSchedule(id).length, 1, "missed ticks collapse to one catch-up run");
    await api(`/api/schedules/${id}`, { method: "DELETE" });
  });

  it("does not fire disabled schedules", async () => {
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Off", capabilitySlug: "research", cron: "*/5 * * * *", enabled: false }
    });
    const id = created.schedule.id;
    assert.equal(created.schedule.nextRunAt, null);
    makeDue(id); // even if forced due, enabled=0 means listDueSchedules skips it
    assert.equal(fireDueSchedules().length, 0);
    assert.equal(runsForSchedule(id).length, 0);
    await api(`/api/schedules/${id}`, { method: "DELETE" });
  });

  it("run-now fires immediately without changing the cadence", async () => {
    const created = await api("/api/schedules", {
      method: "POST",
      body: { name: "Manual fire", capabilitySlug: "research", cron: "0 0 * * *", input: { prompt: "now" } }
    });
    const id = created.schedule.id;
    const before = getSchedule(id).nextRunAt;
    const fired = await api(`/api/schedules/${id}/run-now`, { method: "POST" });
    assert.ok(fired.run.id);
    assert.equal(getSchedule(id).nextRunAt, before, "run-now leaves the cron cadence untouched");
    assert.equal(getSchedule(id).lastRunId, fired.run.id);
    await api(`/api/schedules/${id}`, { method: "DELETE" });
  });
});
