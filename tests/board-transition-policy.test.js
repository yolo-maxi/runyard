import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actorContextFromRequest,
  evaluateBoardMove,
  findTransition,
  laneForStatus,
  summarizeBoardTransitions
} from "../src/boardTransitionPolicy.js";

// A minimal board fixture reproducing the core policy shapes the real
// factory template exercises: guard on the shipping lane, transition
// policy on ready→running and review→shipped.
const board = {
  slug: "factory",
  title: "Factory",
  project: "",
  lanes: [
    { id: "intake", label: "Needs triage", statuses: ["intake"] },
    { id: "ready", label: "Ready", statuses: ["ready"], transitions: [
      { from: "ready", to: "running", allow: { manual: true, workflows: ["implement-change-gated"], runOrigins: ["schedule"] } }
    ] },
    { id: "running", label: "In motion", statuses: ["running"], transitions: [
      { from: "running", to: "review", allow: { manual: true, runOrigins: ["workflow"] } }
    ] },
    { id: "review", label: "Review", statuses: ["review"], transitions: [
      { from: "review", to: "shipped", allow: { actorRoles: ["human"] }, message: "Only humans mark shipped from Review." }
    ] },
    { id: "shipped", label: "Done", statuses: ["shipped", "accepted"], guard: { allowFromStatuses: ["review"], message: "Move through Review first." } }
  ]
};

describe("board transition policy", () => {
  it("finds lane by status", () => {
    assert.equal(laneForStatus(board, "ready").id, "ready");
    assert.equal(laneForStatus(board, "shipped").id, "shipped");
    assert.equal(laneForStatus(board, "accepted").id, "shipped");
    assert.equal(laneForStatus(board, "nope"), null);
  });

  it("returns null when no explicit transition is declared", () => {
    // intake → ready has no rule; unrestricted
    const decision = evaluateBoardMove(board, {
      fromStatus: "intake",
      toStatus: "ready",
      actor: { role: "human" }
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.unrestricted, true);
  });

  it("allows manual moves when allow.manual: true", () => {
    const decision = evaluateBoardMove(board, {
      fromStatus: "ready",
      toStatus: "running",
      actor: { role: "human" }
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.transition.to, "running");
  });

  it("permits the whitelisted workflow", () => {
    const decision = evaluateBoardMove(board, {
      fromStatus: "ready",
      toStatus: "running",
      actor: { workflowSlug: "implement-change-gated", role: "workflow" }
    });
    assert.equal(decision.ok, true);
  });

  it("permits the whitelisted run origin", () => {
    const decision = evaluateBoardMove(board, {
      fromStatus: "ready",
      toStatus: "running",
      actor: { runOrigin: "schedule", role: "schedule" }
    });
    assert.equal(decision.ok, true);
  });

  it("denies with the transition message when nothing matches", () => {
    // Only humans can mark shipped from Review; a workflow-driven PATCH is denied.
    const decision = evaluateBoardMove(board, {
      fromStatus: "review",
      toStatus: "shipped",
      actor: { workflowSlug: "auto-ship", role: "workflow" }
    });
    assert.equal(decision.ok, false);
    assert.match(decision.error, /Only humans mark shipped/);
    assert.equal(decision.transition.to, "shipped");
  });

  it("enforces guard.allowFromStatuses before the policy", () => {
    // From intake straight to shipped violates the guard, regardless of role.
    const decision = evaluateBoardMove(board, {
      fromStatus: "intake",
      toStatus: "shipped",
      actor: { role: "human" }
    });
    assert.equal(decision.ok, false);
    assert.match(decision.error, /Move through Review first/);
  });

  it("treats absent allow as manual-only (a policy line with no allow)", () => {
    const board2 = {
      lanes: [
        { id: "review", label: "Review", statuses: ["review"], transitions: [{ from: "review", to: "shipped" }] },
        { id: "shipped", label: "Done", statuses: ["shipped"] }
      ]
    };
    const denied = evaluateBoardMove(board2, {
      fromStatus: "review",
      toStatus: "shipped",
      actor: { workflowSlug: "x", role: "workflow" }
    });
    assert.equal(denied.ok, false);
    const allowed = evaluateBoardMove(board2, {
      fromStatus: "review",
      toStatus: "shipped",
      actor: { role: "human" }
    });
    assert.equal(allowed.ok, true);
  });

  it("summarizes the whole policy for CLI/MCP inspection", () => {
    const summary = summarizeBoardTransitions(board);
    assert.equal(summary.length, 3);
    assert.deepEqual(summary.map((row) => `${row.from}->${row.to}`), [
      "ready->running",
      "running->review",
      "review->shipped"
    ]);
    const shipped = summary.find((row) => row.to === "shipped");
    assert.deepEqual(shipped.allow.actorRoles, ["human"]);
    assert.equal(shipped.message, "Only humans mark shipped from Review.");
  });

  it("actorContextFromRequest carries token identity but ignores untrusted role claims", () => {
    const context = actorContextFromRequest({ token: { id: "tok_1", name: "release-bot", scopes: ["mcp"] } }, { role: "agent" });
    assert.equal(context.id, "tok_1");
    assert.equal(context.name, "release-bot");
    assert.deepEqual(context.scopes, ["mcp"]);
    assert.equal(context.role, undefined);
  });

  it("actorContextFromRequest accepts run context only from runner/admin scopes", () => {
    const context = actorContextFromRequest(
      { token: { id: "tok_2", name: "runner", scopes: ["runner"] } },
      { role: "workflow", workflowSlug: "implement-change-gated", runOrigin: "workflow" }
    );
    assert.equal(context.role, "workflow");
    assert.equal(context.workflowSlug, "implement-change-gated");
    assert.equal(context.runOrigin, "workflow");
  });

  it("findTransition returns null when the from-lane has no rule", () => {
    assert.equal(findTransition(board, "shipped", "review"), null);
  });
});
