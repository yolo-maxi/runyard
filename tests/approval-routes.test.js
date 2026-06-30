import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalCreateInput,
  childApprovalKey,
  decisionTriggersTerminalDelivery,
  defaultApprovalComment,
  findExistingChildRunApproval,
  linkedApprovalRunId,
  requestedApprovalRunId
} from "../src/approvalRoutes.js";

describe("approval route helpers", () => {
  it("normalizes child approval keys across flat and nested payload shapes", () => {
    assert.deepEqual(childApprovalKey({ childRunId: " run_1 ", approvalNode: " checkpoint " }), {
      childRunId: "run_1",
      nodeId: "checkpoint"
    });
    assert.deepEqual(childApprovalKey({ child: { runId: "run_2", nodeId: "skin" } }), {
      childRunId: "run_2",
      nodeId: "skin"
    });
    assert.equal(childApprovalKey({ childRunId: "run_1" }), null);
  });

  it("finds pending child approvals idempotently", () => {
    const approvals = [
      { id: "a", payload: { childRunId: "run_1", nodeId: "one" } },
      { id: "b", payload: { child: { runId: "run_2", nodeId: "two" } } }
    ];
    assert.equal(findExistingChildRunApproval(approvals, { childRunId: "run_2", approvalNode: "two" }).id, "b");
    assert.equal(findExistingChildRunApproval(approvals, { childRunId: "run_3", nodeId: "x" }), null);
  });

  it("links approvals only to visible run rows", () => {
    const getRun = (id) => (id === "run_exists" ? { id } : null);
    assert.equal(requestedApprovalRunId({ runId: "run_body" }, { childRunId: "run_payload" }), "run_body");
    assert.equal(requestedApprovalRunId({}, { childRunId: "run_payload" }), "run_payload");
    assert.equal(linkedApprovalRunId({ runId: "run_exists" }, {}, { getRun }), "run_exists");
    assert.equal(linkedApprovalRunId({}, { childRunId: "missing" }, { getRun }), null);
  });

  it("builds bounded approval creation input", () => {
    const input = approvalCreateInput(
      {
        runId: "run_exists",
        title: "x".repeat(300),
        description: "d".repeat(2100),
        payload: { ok: true }
      },
      { name: "operator" },
      { getRun: () => ({ id: "run_exists" }) }
    );
    assert.equal(input.runId, "run_exists");
    assert.equal(input.title.length, 240);
    assert.equal(input.description.length, 2000);
    assert.equal(input.requestedBy, "operator");
    assert.deepEqual(input.payload, { ok: true });
  });

  it("centralizes approval resolution comments and terminal delivery decisions", () => {
    assert.equal(defaultApprovalComment("approved"), "Approved from Web/API");
    assert.equal(defaultApprovalComment("changes_requested"), "Changes requested from Web/API");
    assert.equal(defaultApprovalComment("rejected", "Telegram"), "Rejected from Telegram");
    assert.equal(decisionTriggersTerminalDelivery("approved"), false);
    assert.equal(decisionTriggersTerminalDelivery("rejected"), true);
    assert.equal(decisionTriggersTerminalDelivery("changes_requested"), true);
  });
});
