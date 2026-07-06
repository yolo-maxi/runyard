import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalConsequences,
  approvalContext,
  approvalIfIgnored,
  approvalKindLabel,
  approvalPayloadSummary,
  approvalResolutionLabel,
  approvalResolutionSentence,
  approvalResolvedViaLabel,
  humanRunStatusLabel,
  sanitizePayloadField,
  sanitizeForDisplay,
  withApprovalLinks
} from "../src/approvalPresentation.js";
import { telegramApprovalText } from "../src/telegramApprovals.js";

const runs = new Map([
  ["run 1", {
    id: "run 1",
    status: "waiting_approval",
    capabilitySlug: "improve",
    capabilityName: "Improve",
    workflowVersion: "2",
    currentStep: "approval",
    input: { prompt: "ship it" }
  }],
  ["run 2", {
    id: "run 2",
    status: "running",
    capabilitySlug: "app-skinner",
    capabilityName: "App Skinner",
    currentStep: "skin:approval",
    input: {}
  }],
  ["run 3", {
    id: "run 3",
    status: "failed",
    capabilitySlug: "improve",
    capabilityName: "Improve",
    currentStep: "escalated to operator",
    input: {}
  }]
]);

const deps = {
  getRun: (id) => runs.get(id),
  getCapability: (slug) => ({ slug, name: slug === "improve" ? "Improve" : slug, version: "1" }),
  deriveRunTitle: (run) => `Title for ${run.id}`,
  deriveRunDescription: (run) => `Description for ${run.id}`
};

describe("approval presentation helpers", () => {
  it("sanitizes nested display data and redacts secret-looking keys", () => {
    const value = sanitizeForDisplay({
      apiKey: "secret",
      visible: "x".repeat(600),
      nested: { password: "hidden", ok: true, deeper: { value: { tooDeep: "yes" } } },
      items: Array.from({ length: 14 }, (_, index) => index)
    });

    assert.equal(value.apiKey, "[redacted]");
    assert.equal(value.visible.length, 500);
    assert.equal(value.nested.password, "[redacted]");
    assert.equal(value.nested.deeper.value, "[nested value]");
    assert.equal(value.items.length, 13);
    assert.equal(value.items.at(-1), "... 2 more");
  });

  it("applies the same redaction rule to standalone payload fields", () => {
    assert.equal(sanitizePayloadField("authorization", "Bearer abc"), "[redacted]");
    assert.deepEqual(sanitizePayloadField("details", { ok: true }), { ok: true });
  });

  it("summarizes approval payloads without leaking secrets", () => {
    assert.deepEqual(
      approvalPayloadSummary({
        payload: {
          capability: "improve",
          input: { prompt: "fix", token: "abc" },
          privateKey: "key",
          note: "ok"
        }
      }),
      {
        capability: "improve",
        input: { prompt: "fix", token: "[redacted]" },
        privateKey: "[redacted]",
        note: "ok"
      }
    );
  });

  it("builds approval context from payload, run, and capability data", () => {
    const approval = {
      id: "appr 1",
      runId: "run 1",
      status: "pending",
      requestedBy: "fallback",
      payload: {
        capability: "improve",
        origin: { via: "mcp", name: "operator" },
        input: {
          project: "Runyard",
          repo: "runyard",
          path: "src",
          targetBranch: "main",
          deploy: true,
          change: "Refactor approval presentation"
        }
      }
    };

    const context = approvalContext(approval, deps);
    assert.equal(context.requestedBy, "mcp: operator");
    assert.equal(context.workflow.deepLink, "/app#workflows/improve");
    assert.equal(context.project.display, "Runyard / runyard / src");
    assert.equal(context.targetBranch, "main");
    assert.equal(context.deploy, true);
    assert.equal(context.run.deepLink, "/app#runs/run%201");
    assert.equal(context.proposedChange, "Refactor approval presentation");
    assert.equal(context.proposedAction, "Queue Improve for runner execution, with deploy enabled, targeting main.");
  });

  it("decorates approvals with links, context, and payload summaries", () => {
    const decorated = withApprovalLinks({
      id: "appr 1",
      runId: "run 1",
      status: "pending",
      payload: { capability: "improve", input: { prompt: "fix" } }
    }, deps);

    assert.equal(decorated.deepLink, "/app#approvals/appr%201");
    assert.equal(decorated.deepLinkRun, "/app#runs/run%201");
    assert.equal(decorated.context.run.title, "Title for run 1");
    assert.deepEqual(decorated.payloadSummary.input, { prompt: "fix" });
  });

  it("renders a stored ask verbatim and only derives one when none was declared", () => {
    const declared = approvalContext({
      id: "appr ask",
      runId: "run 2",
      status: "pending",
      kind: "workflow_gate",
      ask: { audience: "operators", action: "Pick the skin direction.", reason: "The author requires a human choice." },
      payload: { capability: "app-skinner", nodeId: "skin:approval" }
    }, deps);
    assert.equal(declared.ask.derived, false);
    assert.equal(declared.ask.action, "Pick the skin direction.");
    assert.equal(declared.ask.reason, "The author requires a human choice.");
    assert.equal(declared.ask.audienceLabel, "Anyone operating runs");
    assert.equal(declared.proposedAction, "Pick the skin direction.");

    const derived = approvalContext({
      id: "appr derived",
      runId: "run 2",
      status: "pending",
      kind: "workflow_gate",
      payload: { capability: "app-skinner", nodeId: "skin:approval" }
    }, deps);
    assert.equal(derived.ask.derived, true);
    assert.match(derived.ask.action, /skin:approval/);
  });

  it("keeps input-key scavenging only for ask-less custom cards", () => {
    // A workflow_gate card with an input named `command` must not headline it.
    const gate = approvalContext({
      id: "appr gate",
      runId: "run 2",
      status: "pending",
      kind: "workflow_gate",
      description: "The gate's own summary.",
      payload: { capability: "app-skinner", nodeId: "gate", input: { command: "rm -rf /" } }
    }, deps);
    assert.doesNotMatch(gate.ask.action, /rm -rf/);
    assert.equal(gate.proposedChange, "The gate's own summary.");

    const custom = approvalContext({
      id: "appr custom",
      runId: "run 1",
      status: "pending",
      kind: "custom",
      payload: { capability: "improve", input: { command: "deploy the thing" } }
    }, deps);
    assert.equal(custom.ask.derived, true);
    assert.equal(custom.ask.action, "deploy the thing");
  });

  it("tells the truth per kind about what a decision does", () => {
    // Engine gate on a running run: never claims a queue transition.
    const engineGate = approvalConsequences({ kind: "workflow_gate" }, { status: "running" });
    assert.match(engineGate.ifApproved, /resumes past this gate/);
    assert.doesNotMatch(engineGate.ifApproved, /queued|waiting_approval/);
    assert.match(engineGate.ifRejected, /deny path/);
    assert.doesNotMatch(engineGate.ifRejected, /cancelled/);

    // A gate holding a waiting run: releasing / cancelling is the real effect.
    const heldGate = approvalConsequences({ kind: "workflow_gate" }, { status: "waiting_approval" });
    assert.match(heldGate.ifApproved, /released/);
    assert.match(heldGate.ifRejected, /cancelled/);

    // Escalation: the run already ended; resolving records, never restarts.
    const escalation = approvalConsequences({ kind: "escalation" }, { status: "failed" });
    assert.match(escalation.ifApproved, /not restarted/);
    assert.match(escalation.ifRejected, /Nothing is retried/);

    // Side effect: gates the hook only, the run's work is untouched.
    const sideEffect = approvalConsequences({ kind: "side_effect" }, { status: "succeeded" });
    assert.match(sideEffect.ifApproved, /side effect/);
    assert.match(sideEffect.ifRejected, /unaffected/);

    // Custom on a held run: the actual release/cancel transition.
    const runStart = approvalConsequences({ kind: "custom" }, { status: "waiting_approval" });
    assert.match(runStart.ifApproved, /released to the queue/);
    assert.match(runStart.ifRejected, /will not execute/);

    // Custom on a non-waiting run: honest that nothing moves.
    const detached = approvalConsequences({ kind: "custom" }, { status: "succeeded" });
    assert.match(detached.ifApproved, /not changed/);
  });

  it("states what silence does from the card's actual timer configuration", () => {
    const heldRun = { status: "waiting_approval" };
    assert.match(approvalIfIgnored({ timeoutAt: null }, heldRun), /waits until someone decides/);
    assert.match(approvalIfIgnored({ timeoutAt: null }, heldRun), /held open/);
    assert.match(
      approvalIfIgnored({ timeoutAt: "2026-07-05T00:00:00.000Z", fallback: { decision: "approved" } }, heldRun),
      /If nobody decides by 2026-07-05T00:00:00\.000Z, “Approved” is applied automatically/
    );
    assert.match(
      approvalIfIgnored({ timeoutAt: "2026-07-05T00:00:00.000Z", fallback: null }, heldRun),
      /no decision is invented/
    );
    assert.match(
      approvalIfIgnored({ timeoutAt: "2026-07-05T00:00:00.000Z", timerState: "fallback_required" }, heldRun),
      /needs a human now/
    );
  });

  it("humanizes kinds, resolutions, mechanisms, and run statuses", () => {
    assert.equal(approvalKindLabel("workflow_gate"), "Workflow gate");
    assert.equal(approvalKindLabel("escalation"), "Needs a decision");
    assert.equal(approvalKindLabel(""), "Approval");
    assert.equal(approvalResolutionLabel("changes_requested"), "Changes requested");
    assert.equal(approvalResolutionLabel("superseded"), "Superseded — the run ended first");
    assert.equal(approvalResolutionLabel("option:retry_anyway"), "Chose: retry_anyway");
    assert.equal(approvalResolvedViaLabel("fallback_timer"), "decided by the timer (autopilot)");
    assert.equal(approvalResolvedViaLabel("engine"), "decided on the runner");
    assert.equal(humanRunStatusLabel("waiting_approval"), "Waiting for approval");
    assert.equal(
      approvalResolutionSentence({ status: "resolved", resolution: "approved", resolvedVia: "fallback_timer" }),
      "Approved — decided by the timer (autopilot)"
    );
  });

  it("never leaks raw enums into any rendered approval sentence", () => {
    const RAW_ENUMS = /waiting_approval|changes_requested|fallback_required|fallback_timer|resolved_via|blocked_by_gate|run_start|workflow_gate|side_effect/;
    const cards = [
      { id: "a1", runId: "run 1", status: "pending", kind: "custom", payload: { capability: "improve" } },
      { id: "a2", runId: "run 2", status: "pending", kind: "workflow_gate", payload: { capability: "app-skinner", nodeId: "gate" } },
      { id: "a3", runId: "run 3", status: "pending", kind: "escalation", payload: {} },
      { id: "a4", runId: "run 1", status: "pending", kind: "side_effect", payload: {} },
      {
        id: "a5",
        runId: "run 1",
        status: "pending",
        kind: "custom",
        timeoutAt: "2026-07-05T00:00:00.000Z",
        fallback: { decision: "changes_requested" },
        payload: {}
      },
      { id: "a6", runId: "run 1", status: "pending", kind: "custom", timeoutAt: "2026-07-05T00:00:00.000Z", timerState: "fallback_required", payload: {} },
      { id: "a7", runId: "run 3", status: "resolved", kind: "escalation", resolution: "changes_requested", resolvedVia: "human", resolvedBy: "fran", resolvedAt: "now", payload: {} },
      { id: "a8", runId: "run 1", status: "resolved", kind: "custom", resolution: "superseded", resolvedVia: "system", payload: {} }
    ];
    for (const card of cards) {
      const context = approvalContext(card, deps);
      const sentences = [
        context.ask.action,
        context.ask.reason,
        context.ask.audienceLabel,
        context.whatHappensIfApproved,
        context.whatHappensIfChangesRequested,
        context.whatHappensIfRejected,
        context.whatHappensIfIgnored,
        context.approval.kindLabel,
        context.approval.statusLabel,
        context.approval.resolutionLabel || "",
        context.approval.resolvedViaLabel || "",
        context.approval.resolutionSentence || "",
        context.approval.fallbackDecisionLabel || "",
        context.run?.statusLabel || ""
      ].join("\n");
      assert.doesNotMatch(sentences, RAW_ENUMS, `raw enum leaked for card ${card.id}`);

      // The Telegram rendering of the same card must hold the same line.
      const telegramText = telegramApprovalText(card, {
        approvalContext: (approval) => approvalContext(approval, deps),
        instanceName: "Runyard"
      });
      assert.doesNotMatch(telegramText, RAW_ENUMS, `raw enum leaked into Telegram text for card ${card.id}`);
    }
  });
});
