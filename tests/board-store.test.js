import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { DEFAULT_BOARD_LANES, validateBoardBody } from "../src/boardRecords.js";
import { createBoardStore, DEFAULT_BOARD_SEED } from "../src/boardStore.js";
import { createBoardHandlers } from "../src/boardRoutes.js";
import { createWorkItemStore } from "../src/workItemStore.js";
import { WORK_ITEM_STATUSES } from "../src/workItemRecords.js";

// Boards: durable configured views over work items. Real in-memory SQLite so
// the record SQL (including the JSON lanes/default_workflows columns and the
// unique slug constraint) is exercised for real.
function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const deps = {
    all,
    one,
    run,
    id: (prefix) => `${prefix}_${++counter}`,
    now: () => new Date(1750000000000 + ++counter * 1000).toISOString()
  };
  return { db, boards: createBoardStore(deps), workItems: createWorkItemStore(deps) };
}

describe("board records", () => {
  it("ships a default lane set that covers every non-archived lifecycle status", () => {
    const covered = new Set(DEFAULT_BOARD_LANES.flatMap((lane) => lane.statuses));
    for (const status of WORK_ITEM_STATUSES.filter((s) => s !== "archived")) {
      assert.ok(covered.has(status), `default lanes miss status ${status}`);
    }
  });

  it("validates create bodies: slug shape, title, lane statuses", () => {
    assert.equal(validateBoardBody({ slug: "ok-board", title: "OK" }).ok, true);
    assert.equal(validateBoardBody({ slug: "Bad Slug!", title: "x" }).ok, false);
    assert.equal(validateBoardBody({ slug: "ok", title: "" }).ok, false);
    const badLane = validateBoardBody({ slug: "ok", title: "x", lanes: [{ id: "a", label: "A", statuses: ["nope"] }] });
    assert.equal(badLane.ok, false);
    assert.match(badLane.error, /unknown status/);
    const dupLane = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [
        { id: "a", label: "A", statuses: ["intake"] },
        { id: "a", label: "B", statuses: ["ready"] }
      ]
    });
    assert.equal(dupLane.ok, false);
    assert.match(dupLane.error, /duplicate lane/);
    const badTrigger = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [{ id: "ready", label: "Ready", statuses: ["ready"], trigger: { mode: "explode" } }]
    });
    assert.equal(badTrigger.ok, false);
    assert.match(badTrigger.error, /trigger invalid/);
    const trigger = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [{
        id: "ready",
        label: "Ready",
        statuses: ["ready"],
        trigger: { mode: "confirm", workflow: "runyard-smoke-check", label: "Launch smoke", input: { expectRunner: true } }
      }]
    });
    assert.equal(trigger.ok, true);
    assert.deepEqual(trigger.value.lanes[0].trigger, {
      mode: "confirm",
      workflow: "runyard-smoke-check",
      label: "Launch smoke",
      input: { expectRunner: true }
    });
    const badGuard = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [{ id: "done", label: "Done", statuses: ["shipped"], guard: { allowFromStatuses: ["bogus"] } }]
    });
    assert.equal(badGuard.ok, false);
    assert.match(badGuard.error, /guard invalid/);
    const guard = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [{
        id: "done",
        label: "Done",
        statuses: ["shipped"],
        guard: { allowFromStatuses: ["review"], message: "Review first" }
      }]
    });
    assert.equal(guard.ok, true);
    assert.deepEqual(guard.value.lanes[0].guard, {
      allowFromStatuses: ["review"],
      message: "Review first"
    });
    // A transition targeting a non-existent lane is rejected; a normalized
    // rule preserves manual by default and the workflow allow-list.
    const badTransition = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [
        { id: "ready", label: "Ready", statuses: ["ready"], transitions: [{ to: "phantom" }] },
        { id: "running", label: "In motion", statuses: ["running"] }
      ]
    });
    assert.equal(badTransition.ok, false);
    assert.match(badTransition.error, /unknown lane/);
    const okTransition = validateBoardBody({
      slug: "ok", title: "x",
      lanes: [
        { id: "ready", label: "Ready", statuses: ["ready"], transitions: [
          { to: "running", allow: { workflows: ["implement-change-gated"] } }
        ] },
        { id: "running", label: "In motion", statuses: ["running"] }
      ]
    });
    assert.equal(okTransition.ok, true);
    const readyLane = okTransition.value.lanes.find((lane) => lane.id === "ready");
    assert.equal(readyLane.transitions[0].allow.workflows[0], "implement-change-gated");
    // manual defaults to false when other channels are declared and manual
    // wasn't explicitly set — the whole point of listing workflows is to
    // constrain the move to them.
    assert.equal(readyLane.transitions[0].allow.manual, false);
  });

  it("accepts partial update bodies without slug/title", () => {
    const validated = validateBoardBody({ description: "new copy" }, { partial: true });
    assert.equal(validated.ok, true);
    assert.deepEqual(Object.keys(validated.value), ["description"]);
  });
});

describe("board store", () => {
  it("creates a board with default lanes and looks it up by slug or id", () => {
    const { boards } = createHarness();
    const board = boards.createBoard({ slug: "infra", title: "Infra Train", createdBy: "test" });
    assert.match(board.id, /^board_/);
    assert.equal(board.lanes.length, DEFAULT_BOARD_LANES.length);
    assert.equal(boards.getBoard("infra").id, board.id);
    assert.equal(boards.getBoard(board.id).slug, "infra");
  });

  it("rejects duplicate slugs", () => {
    const { boards } = createHarness();
    boards.createBoard({ slug: "infra", title: "Infra" });
    assert.throws(() => boards.createBoard({ slug: "infra", title: "Again" }), /already exists/);
  });

  it("updates fields partially and keeps slug immutable", () => {
    const { boards } = createHarness();
    boards.createBoard({ slug: "infra", title: "Infra" });
    const updated = boards.updateBoard("infra", { description: "All infra work", project: "infra" });
    assert.equal(updated.description, "All infra work");
    assert.equal(updated.project, "infra");
    assert.equal(updated.title, "Infra");
    assert.equal(updated.slug, "infra");
  });

  it("seeds the default factory board exactly once, personalized by instance name", () => {
    const { boards } = createHarness();
    const seeded = boards.ensureDefaultBoard({ instanceName: "RunYard" });
    assert.equal(seeded.slug, DEFAULT_BOARD_SEED.slug);
    assert.equal(seeded.title, "RunYard Factory");
    assert.equal(seeded.isDefault, true);
    assert.equal(seeded.lanes.length, DEFAULT_BOARD_LANES.length);
    assert.deepEqual(seeded.defaultWorkflows, ["runyard-smoke-check", "implement-change-gated", "docs-update"]);
    assert.equal(seeded.lanes.find((lane) => lane.id === "running").trigger.mode, "confirm");
    assert.deepEqual(seeded.lanes.find((lane) => lane.id === "shipped").guard.allowFromStatuses, ["review"]);
    assert.equal(boards.ensureDefaultBoard({ instanceName: "RunYard" }), null);
    assert.equal(boards.listBoards().length, 1);
  });

  it("lists boards default-first", () => {
    const { boards } = createHarness();
    boards.createBoard({ slug: "zeta", title: "Zeta" });
    boards.createBoard({ slug: "main", title: "Main", isDefault: true });
    assert.deepEqual(boards.listBoards().map((b) => b.slug), ["main", "zeta"]);
  });
});

describe("board routes", () => {
  function createRouteHarness() {
    const { boards, workItems } = createHarness();
    const audits = [];
    const handlers = createBoardHandlers({
      createBoard: (input) => boards.createBoard(input),
      getBoard: boards.getBoard,
      listBoards: boards.listBoards,
      listWorkItems: (filters) => workItems.listWorkItems(filters),
      recordAudit: (...args) => audits.push(args),
      updateBoard: boards.updateBoard,
      workItemRunSummaries: () => new Map()
    });
    const res = () => {
      const out = { statusCode: 200 };
      out.status = (code) => ((out.statusCode = code), out);
      out.json = (body) => ((out.body = body), out);
      return out;
    };
    return { boards, workItems, handlers, res, audits };
  }

  it("returns a board with per-lane counts and its scoped work items", () => {
    const { boards, workItems, handlers, res } = createRouteHarness();
    boards.createBoard({ slug: "factory", title: "Factory" });
    workItems.createWorkItem({ title: "Ready one", status: "ready" });
    workItems.createWorkItem({ title: "Reviewing", status: "review" });
    workItems.createWorkItem({ title: "Scoped out", status: "ready", project: "other" });

    const response = res();
    handlers.getBoard({ params: { slug: "factory" }, query: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.workItems.length, 3); // '' scope = all projects
    const readyLane = response.body.lanes.find((lane) => lane.id === "ready");
    assert.equal(readyLane.count, 2);
    const reviewLane = response.body.lanes.find((lane) => lane.id === "review");
    assert.equal(reviewLane.count, 1);
  });

  it("scopes board membership by project when set", () => {
    const { boards, workItems, handlers, res } = createRouteHarness();
    boards.createBoard({ slug: "scoped", title: "Scoped", project: "alpha" });
    workItems.createWorkItem({ title: "In scope", project: "alpha" });
    workItems.createWorkItem({ title: "Out of scope", project: "beta" });
    const response = res();
    handlers.getBoard({ params: { slug: "scoped" }, query: {} }, response);
    assert.deepEqual(response.body.workItems.map((item) => item.title), ["In scope"]);
  });

  it("404s unknown boards and 400s invalid bodies, 409s duplicate slugs", () => {
    const { handlers, res } = createRouteHarness();
    const missing = res();
    handlers.getBoard({ params: { slug: "nope" }, query: {} }, missing);
    assert.equal(missing.statusCode, 404);

    const invalid = res();
    handlers.createBoard({ body: { slug: "Bad Slug", title: "x" }, token: null }, invalid);
    assert.equal(invalid.statusCode, 400);

    const first = res();
    handlers.createBoard({ body: { slug: "dup", title: "One" }, token: null }, first);
    assert.equal(first.statusCode, 201);
    const dup = res();
    handlers.createBoard({ body: { slug: "dup", title: "Two" }, token: null }, dup);
    assert.equal(dup.statusCode, 409);
  });

  it("creates and updates boards with audit entries", () => {
    const { handlers, res, audits } = createRouteHarness();
    const created = res();
    handlers.createBoard({ body: { slug: "docs", title: "Docs Train" }, token: null }, created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.board.slug, "docs");

    const updated = res();
    handlers.updateBoard({ params: { slug: "docs" }, body: { title: "Docs & Guides" }, token: null }, updated);
    assert.equal(updated.body.board.title, "Docs & Guides");
    assert.deepEqual(audits.map((a) => a[1]), ["board.created", "board.updated"]);
  });
});
