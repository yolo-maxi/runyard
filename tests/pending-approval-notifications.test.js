import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  notifyPendingApprovalForRun,
  pendingApprovalForRun
} from "../src/pendingApprovalNotifications.js";

describe("pending approval notification helpers", () => {
  it("finds only pending approvals for the requested run", () => {
    const approvals = [
      { id: "appr_other", runId: "run_2", status: "pending" },
      { id: "appr_1", runId: "run_1", status: "pending" }
    ];

    const approval = pendingApprovalForRun("run_1", {
      listApprovals: (status) => approvals.filter((item) => item.status === status)
    });

    assert.equal(approval.id, "appr_1");
    assert.equal(pendingApprovalForRun("", { listApprovals: () => approvals }), null);
  });

  it("notifies Telegram when a pending approval exists", async () => {
    const sent = [];
    const approval = await notifyPendingApprovalForRun("run_1", {
      listApprovals: () => [{ id: "appr_1", runId: "run_1" }],
      notifyTelegram: async (item) => sent.push(item)
    });

    assert.equal(approval.id, "appr_1");
    assert.deepEqual(sent, [{ id: "appr_1", runId: "run_1" }]);
  });

  it("does nothing when no pending approval exists", async () => {
    let called = false;

    const approval = await notifyPendingApprovalForRun("run_missing", {
      listApprovals: () => [{ id: "appr_1", runId: "run_1" }],
      notifyTelegram: async () => { called = true; }
    });

    assert.equal(approval, null);
    assert.equal(called, false);
  });
});
