import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-run-smithers-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_run_smithers";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
const {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  classifyChildState,
  classifyWorkflowCodeFailure,
  createWatcherState,
  decideNextAction,
  normalizeErrorFingerprint,
  recordChildAttempt,
  recordRepairAttempt,
  watcherSummary
} = await import("../src/runSmithersWatcher.js");

let server;
let baseUrl;
const token = "shub_test_run_smithers";

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("run-smithers capability", () => {
  it("is seeded as a core Orchestration capability", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((entry) => entry.slug === "run-smithers");
    assert.ok(cap, "run-smithers capability should be seeded");
    assert.equal(cap.category, "Orchestration");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/run-smithers.tsx");
    assert.ok(cap.inputSchema.required.includes("wrappedCapability"));
    assert.ok(cap.requiredAgents.includes("smithers-watcher"));
    assert.ok(cap.requiredSkills.includes("smithers-supervision"));
    assert.equal(cap.approvalPolicy.required, false);
    assert.equal(cap.enabled, true);
  });

  it("seeds the supervising agent + supervision skill", async () => {
    const { agents } = await api("/api/agents");
    const { skills } = await api("/api/skills");
    assert.ok(agents.find((agent) => agent.slug === "smithers-watcher"));
    assert.ok(skills.find((skill) => skill.slug === "smithers-supervision"));
  });

  it("ships the workflow template and watcher helper in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "run-smithers.tsx");
    const helper = path.join(process.cwd(), "workflow-templates", "workflows", "run-smithers-watcher.js");
    assert.ok(existsSync(tpl));
    assert.ok(existsSync(helper));
  });

  it("passes the verified supervision bypass token to self-repair children", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "run-smithers.tsx");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /attemptWorkflowRepair\([^)]*supervisionToken/);
    assert.match(src, /__supervisedChild:\s*\{\s*token:\s*supervisionToken\s*\}/);
    assert.match(src, /implement-change-gated\/run/);
  });

  it("queues immediately and does not block existing capabilities", async () => {
    const created = await api("/api/capabilities/run-smithers/run", {
      method: "POST",
      body: { input: { wrappedCapability: "hello", wrappedInput: { topic: "wrapped" }, goal: "prove wrapping works" } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "run-smithers");
    // existing capabilities must still be visible/runnable
    const hello = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { topic: "still works" } } });
    assert.equal(hello.run.status, "queued");
  });
});

describe("run-smithers watcher classifier + three-strike rule", () => {
  it("normalizes volatile run ids, timestamps, and paths into a stable fingerprint", () => {
    const a = normalizeErrorFingerprint(
      "pnpm install failed at run_abcdef0123456789 in /tmp/runyard-7e0d at 2026-06-19T10:00:00.000Z"
    );
    const b = normalizeErrorFingerprint(
      "pnpm install failed at run_999999bbcc11aa22 in /tmp/runyard-9112 at 2026-06-19T11:25:33.119Z"
    );
    assert.ok(a.length > 0);
    assert.equal(a, b);
    assert.equal(normalizeErrorFingerprint("   "), "");
  });

  it("classifies child states correctly, requiring real success for promotedSuccess", () => {
    assert.equal(classifyChildState({ status: "succeeded", output: { ok: true } }).promotedSuccess, true);
    // succeeded with no output is not a promoted success — keeps the
    // 'never silently mask success' guarantee.
    assert.equal(classifyChildState({ status: "succeeded", output: null }).promotedSuccess, false);
    assert.equal(classifyChildState({ status: "running" }).kind, "running");
    assert.equal(classifyChildState({ status: "failed" }).recoverable, false);
    assert.equal(classifyChildState({ status: "failed", checkpoint: "build" }).recoverable, true);
    assert.equal(classifyChildState({ status: "waiting_approval" }).kind, "waiting_approval");
    assert.equal(classifyChildState(null).kind, "unknown");
  });

  it("retries within budget while fingerprint count is below the threshold", () => {
    const state = createWatcherState({ capabilitySlug: "hello", maxAttempts: 5, fingerprintThreshold: 3 });
    recordChildAttempt(state, { runId: "run_a", status: "failed", error: "ENOMEM in /tmp/xyz" });
    const decision = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(decision.action, "retry");
    assert.equal(state.approvalRequested, false);
    assert.equal(state.outcome, null);
  });

  it("escalates to approval after the same normalized fingerprint appears three times", () => {
    const state = createWatcherState({ capabilitySlug: "hello", fingerprintThreshold: 3, maxAttempts: 10 });
    const error = "pnpm install failed: ENOSPC writing /tmp/runyard-XXXX/.pnpm-store";
    const variants = [
      "pnpm install failed: ENOSPC writing /tmp/runyard-aaaa/.pnpm-store at 2026-06-19T10:00:00.000Z",
      "pnpm install failed: ENOSPC writing /tmp/runyard-bbbb/.pnpm-store at 2026-06-19T10:05:11.500Z",
      "pnpm install failed: ENOSPC writing /tmp/runyard-cccc/.pnpm-store at 2026-06-19T10:09:42.000Z"
    ];
    let lastDecision = null;
    for (const message of variants) {
      recordChildAttempt(state, { runId: "run_x", status: "failed", error: message });
      lastDecision = decideNextAction(state, classifyChildState({ status: "failed" }));
    }
    assert.equal(state.approvalRequested, true);
    assert.equal(lastDecision.action, "approval");
    assert.equal(lastDecision.count, 3);
    assert.match(lastDecision.reason, /three|3/i);
    const optionIds = lastDecision.options.map((option) => option.id);
    assert.ok(optionIds.includes("retry_anyway"));
    assert.ok(optionIds.includes("edit_and_retry"));
    assert.ok(optionIds.includes("abandon"));
    // Watcher must NOT mark the supervising run a success after escalation.
    assert.notEqual(state.outcome, "succeeded");
    // Approval surface is sticky until resolved.
    assert.equal(decideNextAction(state, classifyChildState({ status: "failed" })).action, "approval");

    const summary = watcherSummary(state);
    assert.equal(summary.attempts, 3);
    assert.equal(summary.approvalRequested, true);
    assert.equal(summary.lineage[0].runId, "run_x");
    assert.equal(summary.fingerprintLeaders[0].count, 3);
  });

  it("escalates when maxAttempts is reached even if fingerprints differ", () => {
    const state = createWatcherState({ capabilitySlug: "hello", fingerprintThreshold: 99, maxAttempts: 2 });
    recordChildAttempt(state, { runId: "run_1", status: "failed", error: "boom alpha" });
    recordChildAttempt(state, { runId: "run_2", status: "failed", error: "boom beta" });
    const decision = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(decision.action, "approval");
    assert.match(decision.reason, /maxAttempts/);
    assert.equal(state.approvalRequested, true);
  });

  it("marks promoted success only when the child run reached succeeded with output", () => {
    const state = createWatcherState({ capabilitySlug: "hello" });
    const ok = classifyChildState({ status: "succeeded", output: { answer: 42 } });
    const decision = decideNextAction(state, ok);
    assert.equal(decision.action, "succeed");
    assert.equal(state.outcome, "succeeded");
  });

  it("does not silently auto-resume a cancelled child run", () => {
    const state = createWatcherState({ capabilitySlug: "hello" });
    recordChildAttempt(state, { runId: "run_c", status: "cancelled", error: "" });
    const decision = decideNextAction(state, classifyChildState({ status: "cancelled" }));
    assert.equal(decision.action, "give_up");
  });

  it("exposes sensible defaults", () => {
    assert.equal(RUN_SMITHERS_FINGERPRINT_LIMIT, 3);
    assert.ok(RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS >= 3);
    assert.equal(RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS, 1);
    const state = createWatcherState({});
    assert.equal(state.maxAttempts, RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS);
    assert.equal(state.fingerprintThreshold, RUN_SMITHERS_FINGERPRINT_LIMIT);
    assert.equal(state.maxCodeRepairs, RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS);
    assert.equal(state.codeRepairs, 0);
  });
});

describe("run-smithers workflow-code self-correction", () => {
  it("classifies deterministic workflow-code failures and ignores infra noise", () => {
    assert.equal(
      classifyWorkflowCodeFailure("TypeError: Cannot read properties of undefined (reading 'competitors')").isCodeFailure,
      true
    );
    assert.equal(classifyWorkflowCodeFailure("ReferenceError: foo is not defined").isCodeFailure, true);
    assert.equal(
      classifyWorkflowCodeFailure("smithers run failed at node 'dispatch': boom at product-workflow.tsx:237:42").isCodeFailure,
      true
    );
    // Infra/transient errors must NOT be treated as code bugs.
    assert.equal(classifyWorkflowCodeFailure("pnpm install failed: ENOSPC writing /tmp/x").isCodeFailure, false);
    assert.equal(classifyWorkflowCodeFailure("ETIMEDOUT contacting the model provider").isCodeFailure, false);
    assert.equal(classifyWorkflowCodeFailure("").isCodeFailure, false);
  });

  it("decides a one-shot repair on the first workflow-code failure (the product-workflow dispatch bug)", () => {
    const state = createWatcherState({ capabilitySlug: "product-workflow", maxAttempts: 8, fingerprintThreshold: 3 });
    recordChildAttempt(state, {
      runId: "run_disp1",
      status: "failed",
      failedStep: "dispatch",
      error:
        "smithers run run-1781996504858 failed at node 'dispatch': " +
        "TypeError: Cannot read properties of undefined (reading 'competitors') at renderReport (product-workflow.tsx:237:42)"
    });
    const decision = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(decision.action, "repair", "first code failure should trigger a repair, not a blind retry");
    assert.equal(decision.capability, "product-workflow");
    assert.equal(decision.failedStep, "dispatch");
    assert.equal(state.approvalRequested, false);
  });

  it("repairs at most once per fingerprint, then escalates with a clear artifact if it repeats", () => {
    const state = createWatcherState({ capabilitySlug: "product-workflow", maxAttempts: 8, fingerprintThreshold: 3, maxCodeRepairs: 1 });
    const codeError =
      "smithers run X failed at node 'dispatch': TypeError: Cannot read properties of undefined (reading 'competitors') at product-workflow.tsx:237:42";

    // 1) First failure → repair decision.
    recordChildAttempt(state, { runId: "run_a", status: "failed", failedStep: "dispatch", error: codeError });
    const first = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(first.action, "repair");

    // The template runs the bounded repair + workspace sync, then records it.
    recordRepairAttempt(state, { fingerprint: first.fingerprint, file: "product-workflow.tsx", ok: true, synced: true, testPassed: true });
    assert.equal(state.codeRepairs, 1);

    // 2) Same code failure reappears after the repair → escalate, do NOT repair again.
    recordChildAttempt(state, { runId: "run_b", status: "failed", failedStep: "dispatch", error: codeError });
    const second = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(second.action, "approval");
    assert.equal(second.escalation, "workflow_code_repair_failed");
    assert.equal(state.approvalRequested, true);

    const summary = watcherSummary(state);
    assert.equal(summary.codeRepairs, 1);
    assert.equal(summary.repairs[0].file, "product-workflow.tsx");
    assert.equal(summary.repairs[0].synced, true);
    // Never silently masked as success.
    assert.notEqual(summary.outcome, "succeeded");
  });

  it("does not repair infra failures — those still retry within budget", () => {
    const state = createWatcherState({ capabilitySlug: "improve", maxAttempts: 5, fingerprintThreshold: 3 });
    recordChildAttempt(state, { runId: "run_i", status: "failed", error: "pnpm install failed: ETIMEDOUT" });
    const decision = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(decision.action, "retry");
    assert.equal(state.codeRepairs, 0);
  });

  it("succeeds normally after a repair fixes the workflow code", () => {
    const state = createWatcherState({ capabilitySlug: "product-workflow" });
    recordChildAttempt(state, { runId: "run_a", status: "failed", failedStep: "dispatch", error: "TypeError: x is not a function at wf.tsx:1:1" });
    assert.equal(decideNextAction(state, classifyChildState({ status: "failed" })).action, "repair");
    recordRepairAttempt(state, { fingerprint: state.lastFingerprint, ok: true, synced: true, testPassed: true });
    // Rerun succeeds with output.
    recordChildAttempt(state, { runId: "run_b", status: "succeeded" });
    const decision = decideNextAction(state, classifyChildState({ status: "succeeded", output: { ok: true } }));
    assert.equal(decision.action, "succeed");
    assert.equal(state.outcome, "succeeded");
  });
});
