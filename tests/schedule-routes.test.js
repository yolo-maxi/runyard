import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createScheduleHandlers,
  scheduleRunNowResponse
} from "../src/scheduleRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = {}, query = {}, token = null, tokenName = "operator" } = {}) {
  return {
    body,
    params,
    query,
    token: token || { id: "tok_1", name: tokenName }
  };
}

function harness(overrides = {}) {
  const audits = [];
  const events = [];
  const dispatched = [];
  const fireResults = [];
  const autoDisabled = [];
  const notifications = [];
  const claimed = [];
  const schedules = new Map([
    ["sched_1", {
      id: "sched_1",
      name: "Nightly",
      capabilitySlug: "research",
      cron: "0 0 * * *",
      timezone: "UTC",
      input: { prompt: "status" },
      enabled: true,
      nextRunAt: "2026-06-30T00:00:00.000Z"
    }]
  ]);
  const capabilities = new Map([
    ["research", { slug: "research", name: "Research", enabled: true }],
    ["disabled", { slug: "disabled", name: "Disabled", enabled: false }]
  ]);
  for (const schedule of overrides.schedules || []) schedules.set(schedule.id, schedule);
  for (const capability of overrides.capabilities || []) capabilities.set(capability.slug, capability);

  const handlers = createScheduleHandlers({
    addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
    autoDisableSchedule: (scheduleId, reason, actor) => autoDisabled.push({ scheduleId, reason, actor }),
    claimScheduleFire: (id, nextRunAt, nowIso) => {
      claimed.push({ id, nextRunAt, nowIso });
      return overrides.claimScheduleFire?.(id, nextRunAt, nowIso) || { ok: true };
    },
    createSchedule: (input) => {
      const schedule = { id: `sched_${schedules.size + 1}`, timezone: "UTC", enabled: true, ...input };
      schedules.set(schedule.id, schedule);
      return schedule;
    },
    deleteSchedule: (id) => {
      const schedule = schedules.get(id);
      schedules.delete(id);
      return schedule || null;
    },
    dispatchRun: (capability, input, options) => {
      const run = { id: `run_${dispatched.length + 1}`, capabilitySlug: capability.slug, input, status: "queued" };
      dispatched.push({ capability, input, options, run });
      return { run };
    },
    getCapability: (slug) => capabilities.get(slug) || null,
    getSchedule: (id) => schedules.get(id) || null,
    listApprovals: () => overrides.pendingApprovals || [],
    listDueSchedules: () => overrides.dueSchedules || Array.from(schedules.values()),
    listSchedules: () => Array.from(schedules.values()),
    notifyTelegram: (approval) => {
      notifications.push(approval);
      return Promise.resolve();
    },
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    recordScheduleFireResult: (scheduleId, runId, status) => fireResults.push({ scheduleId, runId, status }),
    setScheduleEnabled: (id, enabled) => {
      const schedule = { ...schedules.get(id), enabled, nextRunAt: enabled ? "2026-07-01T00:00:00.000Z" : null };
      schedules.set(id, schedule);
      return schedule;
    },
    updateSchedule: (id, patch) => {
      const schedule = { ...schedules.get(id), ...patch };
      schedules.set(id, schedule);
      return schedule;
    },
    withRunLinks: (run) => ({ ...run, deepLink: `/app#runs/${run.id}` })
  });

  return { audits, autoDisabled, claimed, dispatched, events, fireResults, handlers, notifications, schedules };
}

describe("schedule route helpers", () => {
  it("builds manual run-now response bodies", () => {
    const body = scheduleRunNowResponse({
      result: {
        run: { id: "run_1", status: "queued" },
        dispatched: { run: { id: "run_1", status: "queued" } }
      },
      schedule: {
        id: "sched_1",
        name: "Nightly",
        capabilitySlug: "research",
        timezone: "UTC",
        enabled: true
      },
      withRunLinks: (run) => ({ ...run, deepLink: `/app#runs/${run.id}` })
    });

    assert.deepEqual(body.run, { id: "run_1", status: "queued", deepLink: "/app#runs/run_1" });
    assert.equal(body.schedule.id, "sched_1");
    assert.equal(body.statusUrl, "/api/runs/run_1");
    assert.equal(body.deepLink, "/app#runs/run_1");
  });

  it("dispatches schedule runs with copied input and audit metadata", () => {
    const { audits, dispatched, events, fireResults, handlers, schedules } = harness();
    const schedule = schedules.get("sched_1");
    const result = handlers.runScheduleNow(schedule, { trigger: "manual", actor: "operator" });

    assert.equal(result.ok, true);
    assert.equal(result.run.id, "run_1");
    assert.deepEqual(dispatched[0].input, { prompt: "status" });
    assert.notEqual(dispatched[0].input, schedule.input);
    assert.equal(dispatched[0].options.requestedBy, "schedule: Nightly");
    assert.deepEqual(dispatched[0].options.origin, {
      type: "schedule",
      label: "schedule: Nightly",
      scheduleId: "sched_1",
      scheduleName: "Nightly",
      trigger: "manual"
    });
    assert.equal(events[0].type, "run.scheduled");
    assert.deepEqual(fireResults[0], { scheduleId: "sched_1", runId: "run_1", status: "queued" });
    assert.equal(audits[0].action, "schedule.fired");
  });

  it("fires claimed due schedules and records unavailable capability failures", () => {
    const { audits, autoDisabled, claimed, fireResults, handlers, notifications } = harness({
      dueSchedules: [
        {
          id: "sched_1",
          name: "Nightly",
          capabilitySlug: "research",
          cron: "0 0 * * *",
          timezone: "UTC",
          input: { prompt: "status" },
          nextRunAt: "2026-06-30T00:00:00.000Z"
        },
        {
          id: "sched_skip",
          name: "Skip",
          capabilitySlug: "research",
          timezone: "UTC",
          input: {},
          nextRunAt: "2026-06-30T00:00:00.000Z"
        },
        {
          id: "sched_bad",
          name: "Bad",
          capabilitySlug: "disabled",
          timezone: "UTC",
          input: {},
          nextRunAt: "2026-06-30T00:00:00.000Z"
        }
      ],
      claimScheduleFire: (id) => ({ ok: id !== "sched_skip" }),
      pendingApprovals: [{ id: "approval_1", runId: "run_1" }]
    });

    const fired = handlers.fireDueSchedules("2026-06-30T00:01:00.000Z");

    assert.deepEqual(fired, ["run_1"]);
    assert.deepEqual(claimed.map((claim) => claim.id), ["sched_1", "sched_skip", "sched_bad"]);
    assert.deepEqual(notifications, [{ id: "approval_1", runId: "run_1" }]);
    assert.equal(fireResults.some((result) => result.scheduleId === "sched_bad" && result.runId === null), false);
    assert.deepEqual(autoDisabled, [{
      scheduleId: "sched_bad",
      reason: "workflow \"disabled\" is disabled",
      actor: "schedule:sched_bad"
    }]);
    assert.ok(audits.some((audit) => audit.action === "schedule.fire_failed" && audit.target === "sched_bad"));
  });

  it("records thrown fire exceptions on the schedule row, not just the audit log", () => {
    const { audits, fireResults, handlers } = harness({
      dueSchedules: [{
        id: "sched_boom",
        name: "Boom",
        capabilitySlug: "research",
        cron: "0 0 * * *",
        timezone: "UTC",
        input: {},
        nextRunAt: "2026-06-30T00:00:00.000Z"
      }],
      claimScheduleFire: () => { throw new Error("db locked"); }
    });

    const fired = handlers.fireDueSchedules("2026-06-30T00:01:00.000Z");

    assert.deepEqual(fired, []);
    assert.deepEqual(fireResults, [{ scheduleId: "sched_boom", runId: null, status: "error: db locked" }]);
    assert.ok(audits.some((audit) => audit.action === "schedule.fire_failed" && audit.detail.error === "db locked"));
  });

  it("handles preview and CRUD route responses", () => {
    const { audits, handlers } = harness();

    const previewRes = response();
    handlers.previewSchedule(req({ query: { cron: "0 9 * * 1-5", timezone: "UTC" } }), previewRes);
    assert.equal(previewRes.body.valid, true);

    const createRes = response();
    handlers.createSchedule(req({
      body: {
        name: "Weekly",
        capabilitySlug: "research",
        cron: "0 12 * * 1",
        input: { prompt: "weekly" }
      }
    }), createRes);
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.body.schedule.name, "Weekly");
    assert.equal(createRes.body.schedule.createdBy, "operator");

    const id = createRes.body.schedule.id;
    const updateRes = response();
    handlers.updateSchedule(req({ params: { id }, body: { description: "Team report" } }), updateRes);
    assert.equal(updateRes.body.schedule.description, "Team report");

    const disableRes = response();
    handlers.disableSchedule(req({ params: { id } }), disableRes);
    assert.equal(disableRes.body.schedule.enabled, false);

    const deleteRes = response();
    handlers.deleteSchedule(req({ params: { id } }), deleteRes);
    assert.equal(deleteRes.body.deleted, true);
    assert.deepEqual(audits.map((audit) => audit.action), [
      "schedule.created",
      "schedule.updated",
      "schedule.disabled",
      "schedule.deleted"
    ]);
  });

  it("falls back to token ids for audit actors", () => {
    const { audits, handlers } = harness();
    const createRes = response();

    handlers.createSchedule(req({
      body: {
        name: "By Id",
        capabilitySlug: "research",
        cron: "0 12 * * 1"
      },
      token: { id: "tok_only" }
    }), createRes);

    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.body.schedule.createdBy, "tok_only");
    assert.equal(audits[0].actor, "tok_only");
  });

  it("runs schedules immediately through the route handler", async () => {
    const { handlers, notifications } = harness({
      pendingApprovals: [{ id: "approval_1", runId: "run_1" }]
    });
    const res = response();

    await handlers.runScheduleNowRoute(req({ params: { id: "sched_1" } }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.run.deepLink, "/app#runs/run_1");
    assert.equal(res.body.statusUrl, "/api/runs/run_1");
    assert.equal(res.body.deepLink, "/app#runs/run_1");
    assert.deepEqual(notifications, [{ id: "approval_1", runId: "run_1" }]);
  });

  it("returns route errors for missing schedules and unavailable capabilities", async () => {
    const missing = harness();
    const missingRes = response();
    await missing.handlers.runScheduleNowRoute(req({ params: { id: "missing" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);

    const missingGetRes = response();
    missing.handlers.getSchedule(req({ params: { id: "missing" } }), missingGetRes);
    assert.equal(missingGetRes.statusCode, 404);

    const missingUpdateRes = response();
    missing.handlers.updateSchedule(req({ params: { id: "missing" }, body: { description: "Nope" } }), missingUpdateRes);
    assert.equal(missingUpdateRes.statusCode, 404);

    const missingEnableRes = response();
    missing.handlers.enableSchedule(req({ params: { id: "missing" } }), missingEnableRes);
    assert.equal(missingEnableRes.statusCode, 404);

    const invalidCreateRes = response();
    missing.handlers.createSchedule(req({ body: { name: "Invalid" } }), invalidCreateRes);
    assert.equal(invalidCreateRes.statusCode, 400);

    const unavailable = harness({
      schedules: [{
        id: "sched_disabled",
        name: "Disabled",
        capabilitySlug: "disabled",
        timezone: "UTC",
        input: {}
      }]
    });
    const unavailableRes = response();
    await unavailable.handlers.runScheduleNowRoute(req({ params: { id: "sched_disabled" } }), unavailableRes);
    assert.equal(unavailableRes.statusCode, 409);
    assert.match(unavailableRes.body.error, /unavailable/);
  });

  it("rejects enabling schedules that point at missing or disabled workflows", () => {
    const { handlers } = harness({
      schedules: [{
        id: "sched_disabled",
        name: "Disabled",
        capabilitySlug: "disabled",
        timezone: "UTC",
        enabled: false,
        input: {}
      }]
    });

    const enableRes = response();
    handlers.enableSchedule(req({ params: { id: "sched_disabled" } }), enableRes);
    assert.equal(enableRes.statusCode, 400);
    assert.match(enableRes.body.error, /disabled/);

    const updateRes = response();
    handlers.updateSchedule(req({ params: { id: "sched_disabled" }, body: { enabled: true } }), updateRes);
    assert.equal(updateRes.statusCode, 400);
    assert.match(updateRes.body.error, /disabled/);

    const createRes = response();
    handlers.createSchedule(req({
      body: {
        name: "Bad target",
        capabilitySlug: "disabled",
        cron: "0 12 * * 1"
      }
    }), createRes);
    assert.equal(createRes.statusCode, 400);
    assert.match(createRes.body.error, /missing or disabled/);
  });
});
