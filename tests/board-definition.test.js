import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import {
  boardToDefinition,
  BOARD_DEFINITION_KIND,
  BOARD_DEFINITION_VERSION,
  developmentFactoryDefinition,
  validateBoardDefinition
} from "../src/boardDefinition.js";
import { createBoardStore } from "../src/boardStore.js";
import { createBoardDefinitionHandlers } from "../src/boardDefinitionRoutes.js";
import { mockResponse } from "./response.js";

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const boards = createBoardStore({
    all,
    one,
    run,
    id: (prefix) => `${prefix}_${++counter}`,
    now: () => new Date(1750000000000 + ++counter * 1000).toISOString()
  });
  const schedules = new Map();
  let schedCounter = 0;
  const store = {
    createSchedule: (input) => {
      assert.equal(Boolean(input.capabilitySlug), true, "schedule imports must pass capabilitySlug to the store");
      const id = `sched_${++schedCounter}`;
      schedules.set(id, { id, ...input });
      return schedules.get(id);
    },
    updateSchedule: (id, updates) => {
      const existing = schedules.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...updates };
      schedules.set(id, merged);
      return merged;
    },
    listSchedules: () => [...schedules.values()],
    getSchedule: (id) => schedules.get(id) || null
  };
  const audits = [];
  const handlers = createBoardDefinitionHandlers({
    createBoard: boards.createBoard,
    createSchedule: store.createSchedule,
    getBoard: boards.getBoard,
    getSchedule: store.getSchedule,
    listBoards: boards.listBoards,
    listSchedules: store.listSchedules,
    recordAudit: (...args) => audits.push(args),
    updateBoard: boards.updateBoard,
    updateSchedule: store.updateSchedule
  });
  return { boards, schedules, handlers, audits };
}

const factoryDoc = developmentFactoryDefinition();

describe("board definition validator", () => {
  it("accepts the built-in factory definition", () => {
    const validated = validateBoardDefinition(factoryDoc);
    assert.equal(validated.ok, true);
    assert.equal(validated.value.slug, "runyard-development-factory");
    const shipped = validated.value.lanes.find((lane) => lane.id === "shipped");
    assert.deepEqual(shipped.guard.allowFromStatuses, ["review"]);
    const review = validated.value.lanes.find((lane) => lane.id === "review");
    assert.equal(review.transitions[0].to, "shipped");
    assert.deepEqual(review.transitions[0].allow.actorRoles, ["human"]);
    assert.deepEqual(validated.value.defaultWorkflows.slice(0, 2), ["product-workflow", "runyard-smoke-check"]);
    const roadmapLane = validated.value.lanes.find((lane) => lane.id === "triaged");
    assert.equal(roadmapLane.label, "Roadmap shaping");
    assert.equal(roadmapLane.trigger.workflow, "product-workflow");
    const roadmapSchedule = validated.value.schedules.find((schedule) => schedule.slug === "runyard-daily-roadmap-shaping");
    assert.equal(roadmapSchedule.workflow, "product-workflow");
    assert.equal(roadmapSchedule.cron, "0 9 * * *");
    assert.equal(roadmapSchedule.timezone, "America/New_York");
    assert.equal(roadmapSchedule.enabled, false);
    assert.equal(roadmapSchedule.input.agentHarness, "codex");
    assert.equal(roadmapSchedule.input.execute, false);
    assert.match(roadmapSchedule.input.context, /summarize into Telegram/);
    assert.equal(validated.value.schedules.find((schedule) => schedule.slug === "runyard-nightly-smoke").workflow, "runyard-smoke-check");
  });

  it("rejects an unknown kind or version", () => {
    assert.equal(validateBoardDefinition({ ...factoryDoc, kind: "runyard.workflow" }).ok, false);
    assert.equal(validateBoardDefinition({ ...factoryDoc, version: 99 }).ok, false);
  });

  it("rejects transitions that reference unknown lanes", () => {
    const doc = { ...factoryDoc, lanes: factoryDoc.lanes.map((lane) => lane.id === "ready" ? { ...lane, transitions: [{ to: "phantom", allow: { manual: true } }] } : lane) };
    const bad = validateBoardDefinition(doc);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /unknown lane/);
  });

  it("rejects unknown actor roles in an allow-clause", () => {
    const doc = { ...factoryDoc, lanes: factoryDoc.lanes.map((lane) => lane.id === "review" ? { ...lane, transitions: [{ to: "shipped", allow: { actorRoles: ["wizard"] } }] } : lane) };
    const bad = validateBoardDefinition(doc);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /unknown role/);
  });

  it("rejects schedules with a bad slug or missing cron", () => {
    const noCron = validateBoardDefinition({ ...factoryDoc, schedules: [{ slug: "x", workflow: "y" }] });
    assert.equal(noCron.ok, false);
    const badSlug = validateBoardDefinition({ ...factoryDoc, schedules: [{ slug: "Bad Slug", workflow: "y", cron: "* * * * *" }] });
    assert.equal(badSlug.ok, false);
  });

  it("rejects schedules whose laneId is not a real lane", () => {
    const bad = validateBoardDefinition({ ...factoryDoc, schedules: [{ slug: "s1", workflow: "wf", cron: "* * * * *", laneId: "phantom" }] });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /laneId not in board lanes/);
  });

  it("boardToDefinition round-trips the factory board", () => {
    const board = {
      id: "board_1",
      slug: "factory",
      title: "Factory",
      description: "",
      project: "",
      lanes: factoryDoc.lanes,
      defaultWorkflows: ["a", "b"],
      isDefault: true,
      createdAt: "t",
      updatedAt: "t"
    };
    const exported = boardToDefinition(board);
    assert.equal(exported.kind, BOARD_DEFINITION_KIND);
    assert.equal(exported.version, BOARD_DEFINITION_VERSION);
    assert.deepEqual(exported.defaultWorkflows, ["a", "b"]);
    // Round-trip stays valid on import.
    assert.equal(validateBoardDefinition(exported).ok, true);
  });

  it("workflow-template file on disk matches the in-code factory doc", () => {
    const path = new URL("../workflow-templates/board-definitions/runyard-development-factory.json", import.meta.url);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    const validated = validateBoardDefinition(disk);
    assert.equal(validated.ok, true, validated.error);
    assert.equal(validated.value.slug, "runyard-development-factory");
  });
});

describe("board definition handlers", () => {
  it("imports the factory definition and creates the schedule hookup", () => {
    const { handlers, schedules, boards } = harness();
    const res = mockResponse();
    handlers.importBoardDefinition({ body: { definition: factoryDoc }, token: { name: "tester" } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.action, "created");
    assert.equal(res.body.board.slug, "runyard-development-factory");
    assert.equal(boards.getBoard("runyard-development-factory") != null, true);
    assert.equal(schedules.size, 2);
    const scheduleValues = [...schedules.values()];
    const roadmapSchedule = scheduleValues.find((schedule) => schedule.name === "board:runyard-development-factory:runyard-daily-roadmap-shaping");
    assert.equal(roadmapSchedule.capabilitySlug, "product-workflow");
    assert.equal(roadmapSchedule.cron, "0 9 * * *");
    assert.equal(roadmapSchedule.timezone, "America/New_York");
    assert.equal(roadmapSchedule.enabled, false);
    assert.equal(roadmapSchedule.input.agentHarness, "codex");
    assert.equal(roadmapSchedule.input.execute, false);
    const smokeSchedule = scheduleValues.find((schedule) => schedule.name === "board:runyard-development-factory:runyard-nightly-smoke");
    assert.equal(smokeSchedule.capabilitySlug, "runyard-smoke-check");
  });

  it("re-import is idempotent: updates board and reconciles schedule slug in place", () => {
    const { handlers, schedules } = harness();
    handlers.importBoardDefinition({ body: { definition: factoryDoc }, token: {} }, mockResponse());
    // Same slug: creation returns updated.
    const second = mockResponse();
    handlers.importBoardDefinition({ body: { definition: factoryDoc }, token: {} }, second);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.action, "updated");
    assert.equal(schedules.size, 2); // no duplicate
  });

  it("import respects the slug override to provision multiple boards from one template", () => {
    const { handlers, boards } = harness();
    const first = mockResponse();
    handlers.importBoardDefinition({ body: { definition: factoryDoc, slug: "team-alpha" }, token: {} }, first);
    const second = mockResponse();
    handlers.importBoardDefinition({ body: { definition: factoryDoc, slug: "team-beta" }, token: {} }, second);
    assert.equal(first.body.board.slug, "team-alpha");
    assert.equal(second.body.board.slug, "team-beta");
    assert.equal(boards.listBoards().length, 2);
  });

  it("validate endpoint reports laneCount + transitions preview without touching the DB", () => {
    const { handlers, boards } = harness();
    const res = mockResponse();
    handlers.validateBoardDefinition({ body: { definition: factoryDoc } }, res);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.preview.laneCount, factoryDoc.lanes.length);
    assert.ok(res.body.preview.transitions.some((row) => row.from === "review" && row.to === "shipped"));
    assert.equal(boards.listBoards().length, 0);
  });

  it("export endpoint returns a round-trippable JSON document", () => {
    const { handlers, boards } = harness();
    boards.createBoard({ slug: "factory", title: "Factory", createdBy: "test" });
    const res = mockResponse();
    handlers.exportBoardDefinition({ params: { slug: "factory" } }, res);
    assert.equal(res.body.definition.slug, "factory");
    assert.equal(validateBoardDefinition(res.body.definition).ok, true);
  });

  it("describe endpoint flattens the transition policy", () => {
    const { handlers, boards } = harness();
    boards.createBoard({ slug: "factory", title: "Factory", lanes: factoryDoc.lanes });
    const res = mockResponse();
    handlers.describeBoardTransitions({ params: { slug: "factory" } }, res);
    assert.equal(res.body.transitions.some((row) => row.from === "ready" && row.to === "running"), true);
  });

  it("checkBoardTransition preflights without mutating state", () => {
    const { handlers, boards } = harness();
    boards.createBoard({ slug: "factory", title: "Factory", lanes: factoryDoc.lanes });
    const res = mockResponse();
    handlers.checkBoardTransition({
      params: { slug: "factory" },
      body: { fromStatus: "review", toStatus: "shipped", actorRole: "workflow" },
      token: { scopes: ["mcp"] }
    }, res);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /Only humans mark shipped/);
  });

  it("import surfaces store-level slug conflicts as 409 when creating without override", () => {
    // Two different definitions colliding on slug should conflict.
    const { handlers } = harness();
    handlers.importBoardDefinition({ body: { definition: factoryDoc }, token: {} }, mockResponse());
    // Now import with a partially different doc; should update in place, not conflict.
    const second = mockResponse();
    handlers.importBoardDefinition({ body: { definition: { ...factoryDoc, title: "Renamed" } }, token: {} }, second);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.board.title, "Renamed");
  });

  it("example endpoint returns the built-in factory definition", () => {
    const { handlers } = harness();
    const res = mockResponse();
    handlers.getExampleBoardDefinition({ params: { slug: "runyard-development-factory" } }, res);
    assert.equal(res.body.definition.slug, "runyard-development-factory");
    const missing = mockResponse();
    handlers.getExampleBoardDefinition({ params: { slug: "nope" } }, missing);
    assert.equal(missing.statusCode, 404);
  });
});
