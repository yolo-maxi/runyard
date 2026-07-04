import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { humanizeStatus, STATUS_LABELS } from "../web/lib/statusLabels.js";

// Pins the admin-gating and status-humanization pass over the React frontend:
// the Admin menu and admin views only render for admin-scoped sessions, catalog
// write affordances hide when saves would 403, and no surface shows a raw
// snake_case status enum as its visible label. The API enforces all of this
// server-side; these assertions keep the UI from advertising levers that fail.
const root = process.cwd();
const shell = readFileSync(path.join(root, "web", "app", "Shell.jsx"), "utf8");
const content = readFileSync(path.join(root, "web", "app", "Content.jsx"), "utf8");
const agents = readFileSync(path.join(root, "web", "views", "Agents.jsx"), "utf8");
const workflows = readFileSync(path.join(root, "web", "views", "Workflows.jsx"), "utf8");
const workflowDetail = readFileSync(path.join(root, "web", "views", "WorkflowDetail.jsx"), "utf8");
const ui = readFileSync(path.join(root, "web", "components", "ui.jsx"), "utf8");
const home = readFileSync(path.join(root, "web", "views", "Home.jsx"), "utf8");

describe("admin gating: the Admin menu is admin-only", () => {
  it("computes the admin flag and gates the admin links on it", () => {
    assert.match(shell, /const admin = meIsAdmin\(me\)/);
    assert.match(shell, /\(admin \? ADMIN_LINKS : \[\]\)\.map/);
  });

  it("keeps a mobile-only More menu (Docs links) for non-admins", () => {
    assert.match(shell, /admin \? "admin-menu" : "admin-menu mobile-menu-only"/);
    assert.match(shell, /\{admin \? "Admin" : "More"\}/);
  });
});

describe("admin gating: admin views resolve to an honest notice for non-admins", () => {
  it("guards every admin route view before dispatch", () => {
    for (const view of ["connect", "tokens", "runners", "audit", "secrets", "settings", "brand"]) {
      assert.match(content, new RegExp(`"${view}"`), `${view} is listed as an admin view`);
    }
    assert.match(content, /ADMIN_VIEWS\.has\(view\) && !meIsAdmin\(me\)/);
    assert.match(content, /Admin only\./);
  });
});

describe("admin gating: catalog write affordances hide when saves would 403", () => {
  it("gates Agents/Skills/Knowledge editors on the admin flag", () => {
    assert.match(agents, /const canEdit = meIsAdmin\(me\)/);
    assert.match(agents, /canEdit \? <button id="new-item"/);
    assert.match(agents, /const editing = canEdit && slug !== undefined/);
  });

  it("gates workflow create/edit affordances on the admin flag", () => {
    assert.match(workflows, /const canEdit = meIsAdmin\(me\)/);
    assert.match(workflows, /canEdit \? <button id="new-cap"/);
    assert.match(workflows, /editing && canEdit \?/);
    assert.match(workflowDetail, /const canEdit = meIsAdmin\(me\)/);
    assert.match(workflowDetail, /canEdit \? <button id="wf-edit"/);
    assert.match(workflowDetail, /sub === "edit" && canEdit \?/);
  });
});

describe("status humanization: users read labels, not enums", () => {
  it("labels every run lifecycle status and terminal failure class", () => {
    assert.equal(humanizeStatus("waiting_approval"), "Waiting for approval");
    assert.equal(humanizeStatus("blocked_by_gate"), "Stopped at a safety gate");
    assert.equal(humanizeStatus("needs_human"), "Needs a human decision");
    assert.equal(humanizeStatus("timed_out"), "Timed out");
    assert.equal(humanizeStatus("changes_requested"), "Changes requested");
    assert.equal(humanizeStatus("succeeded"), "Succeeded");
    // No label may itself contain snake_case leakage.
    for (const [key, label] of Object.entries(STATUS_LABELS)) {
      assert.doesNotMatch(label, /_/, `${key} label is humanized`);
    }
  });

  it("falls back to readable sentence case for unknown enums", () => {
    assert.equal(humanizeStatus("some_new_state"), "Some new state");
    assert.equal(humanizeStatus(""), "");
    assert.equal(humanizeStatus(null), "");
  });

  it("renders the human label in StatusBadge with the raw enum as tooltip only", () => {
    assert.match(ui, /humanizeStatus/);
    assert.match(ui, /\{glyph\}<\/span> \{label\}/);
    assert.doesNotMatch(ui, /\{glyph\}<\/span> \{value\}/);
  });

  it("humanizes the active status filter chip on Home", () => {
    assert.match(home, /humanizeStatus\(filters\.status\)/);
  });
});
