import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the Work (work items / tickets) browser surface: the top-level nav
// entry, hash routes, deep links, the kanban board, the ticket detail with
// linked runs + launcher, the execution-flow stepper, and the board styles.
const root = process.cwd();
const shellJsx = readFileSync(path.join(root, "web", "app", "Shell.jsx"), "utf8");
const routerJs = readFileSync(path.join(root, "web", "lib", "router.js"), "utf8");
const contentJsx = readFileSync(path.join(root, "web", "app", "Content.jsx"), "utf8");
const workItemsJs = readFileSync(path.join(root, "web", "lib", "workItems.js"), "utf8");
const boardJsx = readFileSync(path.join(root, "web", "views", "WorkBoard.jsx"), "utf8");
const detailJsx = readFileSync(path.join(root, "web", "views", "WorkItemDetail.jsx"), "utf8");
const cardJsx = readFileSync(path.join(root, "web", "components", "WorkCard.jsx"), "utf8");
const editorJsx = readFileSync(path.join(root, "web", "components", "WorkItemEditor.jsx"), "utf8");
const stepperJsx = readFileSync(path.join(root, "web", "components", "WorkFlowStepper.jsx"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");

describe("Work: nav + routing", () => {
  it("adds Work to the primary side menu and mobile nav", () => {
    assert.match(shellJsx, /\["work", "work"\]/);
    assert.match(shellJsx, /SidebarButton view="work" primary="work" label="Work"/);
    assert.match(shellJsx, /href="#work" data-primary-view="work"/);
  });

  it("keeps Work out of the admin-only view set", () => {
    assert.doesNotMatch(contentJsx, /ADMIN_VIEWS = new Set\(\[[^\]]*"work"/);
  });

  it("ships deep-link helpers for the board, detail, and flow focus", () => {
    assert.match(routerJs, /work:\s*\(\)\s*=>\s*"#work"/);
    assert.match(routerJs, /workItem:\s*\(id\)\s*=>\s*`#work\//);
    assert.match(routerJs, /workItemFlow:\s*\(id\)\s*=>\s*`#work\/\$\{encodeURIComponent\(id\)\}\/flow`/);
  });

  it("routes #work to the board and #work/:id to the ticket detail", () => {
    assert.match(contentJsx, /view === "work"[\s\S]*?<WorkBoard \/>[\s\S]*?WorkItemDetail/);
    assert.match(contentJsx, /focus=\{segments\[2\] \|\| ""\}/);
  });
});

describe("Work: lifecycle vocabulary + lanes", () => {
  it("knows every lifecycle status", () => {
    for (const status of ["intake", "triaged", "ready", "running", "waiting", "blocked", "review", "shipped", "accepted", "archived"]) {
      assert.match(workItemsJs, new RegExp(`"${status}"`), `missing status ${status}`);
    }
  });

  it("groups all non-archived statuses into board lanes", () => {
    const lanes = workItemsJs.match(/BOARD_LANES = \[[\s\S]*?\n\]/)[0];
    for (const status of ["intake", "triaged", "ready", "running", "waiting", "blocked", "review", "shipped", "accepted"]) {
      assert.match(lanes, new RegExp(`"${status}"`), `status ${status} not in any lane`);
    }
    assert.match(workItemsJs, /ARCHIVED_LANE/);
  });
});

describe("Work: board view", () => {
  it("fetches work items and renders draggable lanes of cards", () => {
    assert.match(boardJsx, /api\(`\/api\/work-items\$\{showArchived \? "\?includeArchived=true" : ""\}`\)/);
    assert.match(boardJsx, /className="board"/);
    assert.match(boardJsx, /className=\{`board-col/);
    assert.match(boardJsx, /className="work-command"/);
    assert.match(boardJsx, /What needs action/);
    assert.match(boardJsx, /<WorkCard/);
    assert.match(cardJsx, /data-drag-work-item=/);
    assert.match(cardJsx, /draggable=\{Boolean\(onDragStart\)\}/);
    assert.match(cardJsx, /work-card-action/);
    assert.match(cardJsx, /workItemAction\(item\)/);
    assert.match(cardJsx, /work-attention/);
    assert.match(boardJsx, /id="new-work-item"/);
    assert.match(boardJsx, /id="work-filter"/);
  });

  it("deduplicates project filters case-insensitively", () => {
    assert.match(boardJsx, /const seen = new Map\(\)/);
    assert.match(boardJsx, /toLowerCase\(\)/);
  });

  it("PATCHes status when a card is moved", () => {
    assert.match(boardJsx, /api\(`\/api\/work-items\/\$\{item\.id\}`, \{ method: "PATCH", body: \{ status \} \}\)/);
    assert.match(boardJsx, /setOptimisticStatus\(item\.id, status\)/);
    assert.match(boardJsx, /onDrop=\{\(e\) => dropOnLane\(e, lane\)\}/);
    assert.match(boardJsx, /startViewTransition/);
  });
});

describe("Work: board instances", () => {
  it("fetches boards and drives lanes/title/scope from the picked board", () => {
    assert.match(boardJsx, /api\("\/api\/boards"\)/);
    assert.match(boardJsx, /board\?\.lanes\?\.length \? board\.lanes : BOARD_LANES/);
    assert.match(boardJsx, /board\?\.title \|\| "Work"/);
    assert.match(boardJsx, /board\?\.project && item\.project !== board\.project/);
    assert.match(boardJsx, /id="work-board-picker"/);
  });

  it("the detail view offers an explicit continue-with-a-workflow affordance", () => {
    assert.match(detailJsx, /Continue with a workflow/);
    assert.match(detailJsx, /move it across the board as they progress/);
  });
});

describe("Work: editor form", () => {
  it("covers the full work-item field set", () => {
    for (const id of ["wi-title", "wi-description", "wi-project", "wi-type", "wi-status", "wi-priority", "wi-owner", "wi-requester", "wi-acceptance", "wi-next-action", "wi-blocked-reason", "wi-due"]) {
      assert.match(editorJsx, new RegExp(`id="${id}"`), `editor is missing #${id}`);
    }
    assert.match(editorJsx, /method: "PATCH"/);
    assert.match(editorJsx, /api\("\/api\/work-items", \{ method: "POST"/);
  });
});

describe("Work: ticket detail", () => {
  it("shows goal, acceptance criteria, next action, blocked reason, and activity", () => {
    assert.match(detailJsx, /api\(`\/api\/work-items\/\$\{id\}`\)/);
    assert.match(detailJsx, /work-next-action/);
    assert.match(detailJsx, /work-blocked-reason/);
    assert.match(detailJsx, /work-activity-list/);
    assert.match(detailJsx, /id="work-item-status"/);
  });

  it("lists linked runs with unlink, link-by-id, and a pre-linked workflow launcher", () => {
    assert.match(detailJsx, /\/unlink-run/);
    assert.match(detailJsx, /\/link-run/);
    assert.match(detailJsx, /workItemId: workItem\.id/);
    assert.match(detailJsx, /workflowsCollection/);
    assert.match(detailJsx, /id="work-launch-run"/);
  });

  it("gates delete behind admin and confirms it", () => {
    assert.match(detailJsx, /meIsAdmin\(me\)/);
    assert.match(detailJsx, /window\.confirm/);
    assert.match(detailJsx, /method: "DELETE"/);
  });
});

describe("Work: execution flow", () => {
  it("fetches the run flow and polls while the run is active", () => {
    assert.match(detailJsx, /api\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/flow`\)/);
    assert.match(detailJsx, /isActiveRun\(run\) \? 5_000 : false/);
    assert.match(detailJsx, /id="work-flow-run-picker"/);
  });

  it("renders a stepper with every per-step state", () => {
    for (const state of ["done", "active", "failed", "waiting", "cancelled", "skipped", "pending"]) {
      assert.match(workItemsJs, new RegExp(`${state}:`), `glyph missing for ${state}`);
    }
    assert.match(stepperJsx, /state-\$\{node\.state\}/);
    assert.match(stepperJsx, /pendingApprovals/);
    assert.match(detailJsx, /<WorkFlowStepper/);
  });

  it("tints the shared workflow graph by state without breaking the kind palette", () => {
    const graphJsx = readFileSync(path.join(root, "web", "components", "WorkflowGraph.jsx"), "utf8");
    assert.match(graphJsx, /function stateColor\(state\)/);
    assert.match(graphJsx, /node\.state && stateColor\(node\.state\)\) \|\| nodeColor\(node\.kind\)/);
  });
});

describe("Work: styles", () => {
  it("ships the board, card, and stepper styles", () => {
    for (const cls of [".work-command", ".work-operator-item", ".board", ".board-col", ".board-col.is-drop-target", ".board-col-header", ".work-card", ".work-card.is-dragging", ".work-card-action", ".work-attention", ".work-flow-step", ".work-flow-step.state-active", ".work-flow-step.state-failed", ".work-blocked-reason", ".work-priority-urgent"]) {
      assert.ok(css.includes(cls), `styles.css is missing ${cls}`);
    }
  });
});

describe("Work: API client discipline", () => {
  it("only calls registered endpoints", () => {
    const sources = [boardJsx, detailJsx, editorJsx, cardJsx, stepperJsx];
    const allowed = ["/api/work-items", "/api/runs/", "/api/workflows/", "/api/boards"];
    for (const source of sources) {
      for (const match of source.matchAll(/api\(\s*[`"](\/[^`"]*)/g)) {
        const url = match[1];
        assert.ok(allowed.some((prefix) => url.startsWith(prefix)), `unexpected API path ${url}`);
      }
    }
  });
});
