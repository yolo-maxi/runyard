import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the Schedules (cron jobs) browser surface: the nav entry, hash route,
// deep-link helpers, and the list/detail/form view components. After the
// React + TanStack rewrite the real source lives under web/; the legacy
// public/app.js is now a built bundle. Each assertion below is repointed at
// the web/ module that now implements the same feature, asserting an
// equivalent construct that actually exists there. Style assertions stay on
// the shipped public/styles.css (unchanged).
const root = process.cwd();
const shellJsx = readFileSync(path.join(root, "web", "app", "Shell.jsx"), "utf8");
const routerJs = readFileSync(path.join(root, "web", "lib", "router.js"), "utf8");
const contentJsx = readFileSync(path.join(root, "web", "app", "Content.jsx"), "utf8");
const schedulesJsx = readFileSync(path.join(root, "web", "views", "Schedules.jsx"), "utf8");
const scheduleEditorJsx = readFileSync(path.join(root, "web", "components", "ScheduleEditor.jsx"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");

describe("Schedules: nav + routing", () => {
  it("adds Schedules to the primary side menu", () => {
    assert.match(shellJsx, /\["schedules", "schedules"\]/);
    assert.match(shellJsx, /SidebarButton view="schedules" primary="schedules" label="Schedules"/);
    assert.doesNotMatch(shellJsx, /\[\s*"schedules"\s*,\s*"Schedules"\s*\]/);
  });

  it("ships deep-link helpers for the schedules list + detail", () => {
    // deepLinks object in lib/router.js.
    assert.match(routerJs, /schedules:\s*\(\)\s*=>\s*"#schedules"/);
    assert.match(routerJs, /schedule:\s*\(id\)\s*=>\s*`#schedules\//);
  });

  it("routes #schedules to the list and #schedules/:id to the detail", () => {
    // Route dispatch in app/Content.jsx renders ScheduleDetail for a segment,
    // otherwise the Schedules list.
    assert.match(
      contentJsx,
      /view === "schedules"[\s\S]*?ScheduleDetail[\s\S]*?<Schedules \/>/
    );
  });
});

describe("Schedules: views + form", () => {
  it("renders a list with a New Schedule action and an empty state", () => {
    // views/Schedules.jsx is the list view.
    assert.match(schedulesJsx, /New Schedule/);
    assert.match(schedulesJsx, /className="empty"/);
    assert.match(schedulesJsx, /data-run-schedule=/);
    assert.match(schedulesJsx, /data-toggle-schedule=/);
    assert.match(schedulesJsx, /data-delete-schedule=/);
    assert.match(schedulesJsx, /Broken \/ auto-disabled/);
    assert.match(schedulesJsx, /schedule-broken/);
  });

  it("builds a create/edit form with a workflow picker, cron input, and JSON input", () => {
    // components/ScheduleEditor.jsx is the create/edit form.
    assert.match(scheduleEditorJsx, /id="sched-cap"/); // workflow picker
    assert.match(scheduleEditorJsx, /id="sched-cron"/); // cron expression
    assert.match(scheduleEditorJsx, /id="sched-input"[\s\S]*?data-ftype="json"/); // JSON input
    assert.match(scheduleEditorJsx, /id="sched-timezone"/);
    assert.match(scheduleEditorJsx, /type="datetime-local"/); // one-shot support
  });

  it("wires a live, debounced cron preview against the preview endpoint", () => {
    // CronPreview in components/ScheduleEditor.jsx debounces input via setTimeout
    // and validates against the preview endpoint.
    assert.match(scheduleEditorJsx, /\/api\/schedules\/preview\?cron=/);
    assert.match(scheduleEditorJsx, /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\d+\)/); // debounce
  });

  it("styles the schedule preview + chips", () => {
    assert.match(css, /\.schedule-preview\s*\{/);
    assert.match(css, /\.schedule-preview\.invalid/);
    assert.match(css, /\.chip-next/);
  });
});
