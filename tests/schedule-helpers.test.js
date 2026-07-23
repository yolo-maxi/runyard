import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schedulePreview, validateScheduleBody, withScheduleView } from "../src/scheduleHelpers.js";

const capabilities = new Map([
  ["research", { slug: "research", enabled: true }],
  ["disabled", { slug: "disabled", enabled: false }]
]);
const getCapability = (slug) => capabilities.get(slug);

describe("schedule helpers", () => {
  it("validates new schedules and normalizes aliases", () => {
    const result = validateScheduleBody(
      {
        name: " Nightly ",
        capability: "research",
        cron: "0 0 * * *",
        timezone: "UTC",
        input: { prompt: "status" },
        enabled: "false"
      },
      { getCapability }
    );

    assert.deepEqual(result, {
      ok: true,
      value: {
        name: "Nightly",
        capabilitySlug: "research",
        timezone: "UTC",
        cron: "0 0 * * *",
        input: { prompt: "status" },
        enabled: false
      }
    });
  });

  it("rejects invalid schedule inputs", () => {
    assert.equal(validateScheduleBody({}, { getCapability }).error, "name is required");
    assert.match(
      validateScheduleBody({ name: "x", capabilitySlug: "disabled", cron: "0 0 * * *" }, { getCapability }).error,
      /cannot enable schedule: workflow "disabled" is missing or disabled/
    );
    assert.match(
      validateScheduleBody({ name: "x", capabilitySlug: "research", cron: "99 * * * *" }, { getCapability }).error,
      /invalid cron expression/
    );
    assert.equal(
      validateScheduleBody({ name: "x", capabilitySlug: "research", cron: "0 0 * * *", input: [] }, { getCapability }).error,
      "input must be a JSON object"
    );
  });

  it("validates partial updates without requiring unchanged fields", () => {
    assert.deepEqual(validateScheduleBody({ description: "next" }, { partial: true, getCapability }), {
      ok: true,
      value: { description: "next" }
    });
  });

  it("accepts the advertised workflow/workflowSlug field names", () => {
    assert.deepEqual(validateScheduleBody({ workflowSlug: "research" }, { partial: true, getCapability }), {
      ok: true,
      value: { capabilitySlug: "research" }
    });
    assert.deepEqual(validateScheduleBody({ workflow: "research" }, { partial: true, getCapability }), {
      ok: true,
      value: { capabilitySlug: "research" }
    });
  });

  it("builds cron previews for routes and schedules", () => {
    const from = new Date("2026-06-22T10:15:00.000Z");
    assert.deepEqual(schedulePreview("0 9 * * 1-5", "UTC", 2, from), {
      ok: true,
      value: {
        valid: true,
        timezone: "UTC",
        description: "Custom schedule (0 9 * * 1-5)",
        nextRuns: ["2026-06-23T09:00:00.000Z", "2026-06-24T09:00:00.000Z"]
      }
    });
    assert.deepEqual(schedulePreview("", "UTC"), {
      ok: false,
      status: 400,
      error: "cron query parameter is required"
    });
  });

  it("decorates schedules with preview and app links", () => {
    const schedule = withScheduleView(
      {
        id: "sched 1",
        enabled: true,
        cron: "0 0 * * *",
        timezone: "UTC"
      },
      { from: new Date("2026-06-22T10:15:00.000Z") }
    );

    assert.equal(schedule.deepLink, "/app#schedules/sched%201");
    assert.equal(schedule.preview.description, "Daily at 00:00 UTC");
    assert.deepEqual(schedule.preview.nextRuns, [
      "2026-06-23T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
      "2026-06-25T00:00:00.000Z"
    ]);

    assert.deepEqual(withScheduleView({ id: "once", enabled: false, runAt: "2030-01-01T00:00:00.000Z" }).preview, {
      description: "Once at 2030-01-01T00:00:00.000Z",
      nextRuns: []
    });
  });
});
