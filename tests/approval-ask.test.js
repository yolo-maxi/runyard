import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_ASK_AUDIENCES,
  approvalAskIncomplete,
  humanizeApprovalAudience,
  normalizeApprovalAsk,
  normalizeApprovalAskOption
} from "../src/approvalAsk.js";

describe("approval ask contract", () => {
  it("normalizes a declared ask with audience default and trimmed fields", () => {
    assert.deepEqual(APPROVAL_ASK_AUDIENCES, ["operators", "admins"]);
    assert.deepEqual(
      normalizeApprovalAsk({ action: "  Publish the site to repo.box.  ", reason: "Leaves the run sandbox." }),
      {
        audience: "operators",
        action: "Publish the site to repo.box.",
        reason: "Leaves the run sandbox."
      }
    );
    assert.equal(normalizeApprovalAsk({ action: "x", reason: "y", audience: "admins" }).audience, "admins");
    // Unknown audiences fall back to operators rather than inventing scopes.
    assert.equal(normalizeApprovalAsk({ action: "x", reason: "y", audience: "everyone" }).audience, "operators");
  });

  it("rejects asks that cannot answer what happens and why", () => {
    assert.equal(normalizeApprovalAsk(null), null);
    assert.equal(normalizeApprovalAsk("approve it"), null);
    assert.equal(normalizeApprovalAsk({ action: "do it" }), null);
    assert.equal(normalizeApprovalAsk({ reason: "because" }), null);
    assert.equal(normalizeApprovalAsk({ action: "   ", reason: "because" }), null);
    assert.equal(approvalAskIncomplete({ ask: null }), true);
    assert.equal(approvalAskIncomplete({ ask: { action: "a", reason: "b" } }), false);
  });

  it("keeps only well-formed options and caps their count", () => {
    assert.deepEqual(normalizeApprovalAskOption({ id: "retry_anyway", label: "Resume once more", effect: "requeues" }), {
      id: "retry_anyway",
      label: "Resume once more",
      effect: "requeues"
    });
    assert.equal(normalizeApprovalAskOption({ id: "  " }), null);
    assert.equal(normalizeApprovalAskOption({ id: "bad id!" }), null);
    const ask = normalizeApprovalAsk({
      action: "a",
      reason: "b",
      options: [{ id: "one" }, { id: "" }, "junk", { id: "two", label: "Two" }]
    });
    assert.deepEqual(ask.options.map((option) => option.id), ["one", "two"]);
    // Label falls back to the id so options never render blank.
    assert.equal(ask.options[0].label, "one");
    // No valid options -> the key is omitted entirely.
    assert.equal("options" in normalizeApprovalAsk({ action: "a", reason: "b", options: ["x"] }), false);
  });

  it("truncates runaway ask text instead of storing essays", () => {
    const ask = normalizeApprovalAsk({ action: "x".repeat(900), reason: "y".repeat(900) });
    assert.ok(ask.action.length <= 500);
    assert.ok(ask.reason.length <= 500);
  });

  it("humanizes audiences for display", () => {
    assert.equal(humanizeApprovalAudience("admins"), "Admins");
    assert.equal(humanizeApprovalAudience("operators"), "Anyone operating runs");
    assert.equal(humanizeApprovalAudience(""), "Anyone operating runs");
  });
});
