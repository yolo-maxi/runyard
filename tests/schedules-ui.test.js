import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the Schedules (cron jobs) browser surface: the nav entry, hash route,
// deep-link helpers, and the list/detail/form view functions. Content
// assertions on the shipped static assets, matching the rest of the
// browser-asset suite.
const root = process.cwd();
const appJs = readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");
const indexHtml = readFileSync(path.join(root, "public", "index.html"), "utf8");

describe("Schedules: nav + routing", () => {
  it("adds a Schedules entry to the Admin menu", () => {
    assert.match(indexHtml, /data-view="schedules"[^>]*>Schedules</);
  });

  it("ships deep-link helpers for the schedules list + detail", () => {
    assert.match(appJs, /schedules:\s*\(\)\s*=>\s*"#schedules"/);
    assert.match(appJs, /schedule:\s*\(id\)\s*=>\s*`#schedules\//);
  });

  it("routes #schedules to the list and #schedules/:id to the detail", () => {
    assert.match(appJs, /view === "schedules"[\s\S]*?renderScheduleDetail\(segments\[1\]\)[\s\S]*?renderSchedules\(\)/);
  });
});

describe("Schedules: views + form", () => {
  it("renders a list with a New Schedule action and an empty state", () => {
    const fn = appJs.slice(appJs.indexOf("async function renderSchedules"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    assert.match(body, /New Schedule/);
    assert.match(body, /class="empty"|empty\(/);
    assert.match(body, /data-run-schedule=/);
    assert.match(body, /data-toggle-schedule=/);
    assert.match(body, /data-delete-schedule=/);
  });

  it("builds a create/edit form with a workflow picker, cron input, and JSON input", () => {
    const fn = appJs.slice(appJs.indexOf("async function editSchedule"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    assert.match(body, /id="sched-cap"/); // workflow picker
    assert.match(body, /id="sched-cron"/); // cron expression
    assert.match(body, /id="sched-input"[\s\S]*?data-ftype="json"/); // JSON input
    assert.match(body, /id="sched-timezone"/);
    assert.match(body, /type="datetime-local"/); // one-shot support
  });

  it("wires a live, debounced cron preview against the preview endpoint", () => {
    const fn = appJs.slice(appJs.indexOf("function bindCronPreview"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    assert.match(body, /\/api\/schedules\/preview\?cron=/);
    assert.match(body, /setTimeout\(update, \d+\)/); // debounce
  });

  it("styles the schedule preview + chips", () => {
    assert.match(css, /\.schedule-preview\s*\{/);
    assert.match(css, /\.schedule-preview\.invalid/);
    assert.match(css, /\.chip-next/);
  });
});
