import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEscalationApproval,
  buildHubRepairInput
} from "../src/hubSupervisorRepair.js";

describe("hub supervisor repair and escalation helpers", () => {
  it("builds scoped repair input without deploying or targeting main", () => {
    const input = buildHubRepairInput(
      {
        capabilitySlug: "canary",
        input: {
          repoDir: "/srv/repo",
          repo: "ignored",
          __execution: { mode: "remote", runnerLocation: "canary" }
        }
      },
      { fingerprint: "referenceerror: x" },
      { wrappedEntry: ".smithers/workflows/canary.tsx", repairBranch: "main" }
    );

    assert.equal(input.deploy, false);
    assert.equal(input.targetBranch, "smithers-self-repair");
    assert.equal(input.repoDir, "/srv/repo");
    assert.equal(input.repo, undefined);
    assert.deepEqual(input.__execution, { mode: "remote", runnerLocation: "canary" });
    assert.match(input.workPrompt, /Likely source: \.smithers\/workflows\/canary\.tsx/);
  });

  it("allows a non-main repair branch and selector fallbacks", () => {
    assert.equal(buildHubRepairInput({ input: { repo: "runyard" } }, {}, { repairBranch: "repair/x" }).targetBranch, "repair/x");
    assert.equal(buildHubRepairInput({ input: { repo: "runyard" } }, {}).repo, "runyard");
    assert.equal(buildHubRepairInput({ input: { project: "proj" } }, {}).project, "proj");
  });

  it("builds standard escalation approval payloads", () => {
    const approval = buildEscalationApproval(
      { id: "run_1", capabilitySlug: "hello" },
      { escalation: "loop_breaker", fingerprint: "fp", attempt: 2, reason: "needs review" }
    );

    assert.equal(approval.title, "Needs a decision: hello");
    assert.equal(approval.description, "needs review");
    // The declared ask: honest that resolving records guidance and does not
    // requeue the already-failed run (no option handlers exist yet).
    assert.equal(approval.ask.audience, "operators");
    assert.match(approval.ask.action, /re-run it from the run page/i);
    assert.equal(approval.ask.reason, "needs review");
    assert.equal(approval.payload.kind, "supervisor_escalation");
    assert.equal(approval.payload.escalation, "loop_breaker");
    assert.equal(approval.payload.fingerprint, "fp");
    assert.deepEqual(approval.payload.options.map((option) => option.id), ["retry_anyway", "edit_and_retry", "abandon"]);
  });
});
