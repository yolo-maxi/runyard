import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatDuration, relativeTime, runDurationMs } from "../web/lib/format.js";
import { deepLinks } from "../web/lib/router.js";
import {
  decorateEvent,
  eventCategoryClient,
  eventNodeClient,
  eventSeverityClient,
  runLogTextDump
} from "../web/lib/runEvents.js";
import {
  approvalWorkflowLabel,
  artifactDisplayName,
  cleanFailureText,
  formatBytes,
  isActiveRun,
  isDiagnosticRun,
  isSupervisedChildRun,
  isUnresolvedFailure,
  runBranch,
  runDescription,
  runExecutionLabel,
  runPhaseDurations,
  runPhaseStates,
  runProject,
  runTitle,
  summarizeFailure,
  timeRangeToSinceISO,
  topLevelRuns,
  truncate
} from "../web/lib/runHelpers.js";

describe("web formatting helpers", () => {
  it("formats durations across millisecond, second, minute, and hour ranges", () => {
    assert.equal(formatDuration(null), "");
    assert.equal(formatDuration(Number.NaN), "");
    assert.equal(formatDuration(999), "999ms");
    assert.equal(formatDuration(1000), "1s");
    assert.equal(formatDuration(61_000), "1m 1s");
    assert.equal(formatDuration(3_600_000 + 120_000), "1h 2m");
  });

  it("derives run durations from explicit or timestamp fields", () => {
    assert.equal(runDurationMs({ durationMs: 1234 }), 1234);
    assert.equal(
      runDurationMs({
        createdAt: "2026-07-02T12:00:00.000Z",
        startedAt: "2026-07-02T12:00:05.000Z",
        completedAt: "2026-07-02T12:00:45.000Z"
      }),
      40_000
    );
    assert.equal(
      runDurationMs({ createdAt: "2026-07-02T12:00:00.000Z" }, Date.parse("2026-07-02T12:00:03.000Z")),
      3000
    );
    assert.equal(runDurationMs({ createdAt: "not-a-date" }), null);
  });

  it("renders relative time for past, future, invalid, and missing inputs", () => {
    const now = Date.parse("2026-07-02T12:00:00.000Z");
    assert.equal(relativeTime("", now), "");
    assert.equal(relativeTime("not-a-date", now), "not-a-date");
    assert.equal(relativeTime("2026-07-02T11:59:30.000Z", now), "just now");
    assert.equal(relativeTime("2026-07-02T11:45:00.000Z", now), "15m ago");
    assert.equal(relativeTime("2026-07-02T08:00:00.000Z", now), "4h ago");
    assert.equal(relativeTime("2026-06-29T12:00:00.000Z", now), "3d ago");
    assert.equal(relativeTime("2026-07-02T12:00:30.000Z", now), "in <1m");
    assert.equal(relativeTime("2026-07-02T13:30:00.000Z", now), "in 2h");
  });
});

describe("web router deep links", () => {
  it("parses hash routes with decoded segments and query params", () => {
    const route = deepLinks.parse("#runs/run_123/logs?status=failed&limit=10");
    assert.equal(route.view, "runs");
    assert.deepEqual(route.segments, ["runs", "run_123", "logs"]);
    assert.equal(route.params.get("status"), "failed");
    assert.equal(route.params.get("limit"), "10");
  });

  it("builds encoded shareable hashes for resources", () => {
    assert.equal(deepLinks.run("run 1/2"), "#runs/run%201%2F2");
    assert.equal(deepLinks.workflow("hello/world"), "#workflows/hello%2Fworld");
    assert.equal(deepLinks.artifact({ runId: "run_1", id: "artifact/a b" }), "#runs/run_1/artifacts/artifact%2Fa%20b");
    assert.equal(deepLinks.artifact(null), "#runs");
  });
});

describe("run helper derivations", () => {
  it("classifies active, diagnostic, unresolved, and supervised child runs", () => {
    const active = { status: "waiting_approval" };
    const failed = { status: "failed" };
    const child = { input: { __origin: { parentRunId: "run_parent", label: "run-smithers wrapper" } } };
    const normal = { id: "run_top", status: "succeeded" };

    assert.equal(isActiveRun(active), true);
    assert.equal(isDiagnosticRun(active), true);
    assert.equal(isDiagnosticRun(failed), true);
    assert.equal(isUnresolvedFailure(failed), true);
    assert.equal(isUnresolvedFailure({ status: "cancelled" }), false);
    assert.equal(isSupervisedChildRun(child), true);
    assert.deepEqual(topLevelRuns([normal, child]), [normal]);
  });

  it("derives run title, description, project, branch, and execution labels", () => {
    const run = {
      capabilityName: "Implement",
      input: {
        topic: "Add a focused browser test for the schedule form",
        description: "Detailed request from the operator",
        repo: "yolo-maxi/runyard",
        branch: "feature/tests",
        __execution: { requested: true, mode: "remote", runnerLocation: "pool-a" }
      }
    };
    assert.equal(runTitle(run), "Add a focused browser test for the schedule form");
    assert.equal(runDescription(run), "Detailed request from the operator");
    assert.equal(runProject(run), "yolo-maxi/runyard");
    assert.equal(runBranch(run), "feature/tests");
    assert.equal(runExecutionLabel(run), "remote (pool-a)");
    assert.equal(runExecutionLabel({ input: {} }), "");
    assert.equal(truncate("one two three four", 10), "one two\u2026");
  });

  it("formats byte counts and artifact display names", () => {
    assert.equal(formatBytes(null), "");
    assert.equal(formatBytes(999), "999 B");
    assert.equal(formatBytes(2048), "2.0 kB");
    assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
    assert.equal(artifactDisplayName({ name: "artifact", mimeType: "application/json" }), "artifact.json");
    assert.equal(artifactDisplayName({ name: "report", kind: "diagnostics", mimeType: "text/markdown" }), "diagnostics/report.md");
    assert.equal(artifactDisplayName({ name: "diagnostics/report.md", kind: "diagnostics" }), "diagnostics/report.md");
  });

  it("computes progress strip phase states and durations", () => {
    const now = Date.parse("2026-07-02T12:00:00.000Z");
    assert.deepEqual(
      runPhaseStates({ status: "queued", createdAt: "2026-07-02T11:59:59.000Z" }, now),
      { queued: "active", running: "pending", outcome: "pending" }
    );
    assert.equal(
      runPhaseStates({ status: "running", updatedAt: "2026-07-02T11:59:40.000Z" }, now).running,
      "stalled"
    );
    assert.equal(runPhaseStates({ status: "succeeded" }, now).outcome, "ok");
    assert.equal(runPhaseStates({ status: "failed" }, now).outcome, "fail");
    assert.equal(runPhaseStates({ status: "cancelled" }, now).outcome, "cancel");

    assert.deepEqual(
      runPhaseDurations({
        status: "succeeded",
        createdAt: "2026-07-02T12:00:00.000Z",
        startedAt: "2026-07-02T12:00:10.000Z",
        completedAt: "2026-07-02T12:00:40.000Z"
      }),
      { queued: { ms: 10_000, liveStart: null }, running: { ms: 30_000, liveStart: null }, outcome: { ms: null, liveStart: null } }
    );
  });

  it("summarizes failures without leaking noisy ids", () => {
    const cleaned = cleanFailureText("NodeFailed: during node node_abcdef123456: TypeError: nope run_deadbeef0011");
    assert.equal(cleaned.includes("node_abcdef123456"), false);
    assert.equal(cleaned.includes("run_deadbeef0011"), false);

    assert.equal(summarizeFailure({ status: "failed", error: "fetch failed: ENOTFOUND api.example" }).label, "Network error");
    assert.equal(summarizeFailure({ status: "failed", error: "Permission denied: 403" }).label, "Permission denied");
    assert.equal(summarizeFailure({ status: "cancelled", error: "" }).label, "Cancelled");
    assert.equal(summarizeFailure(null), null);
  });

  it("converts time ranges and approval labels", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-07-02T12:00:00.000Z");
    try {
      assert.equal(timeRangeToSinceISO("1h"), "2026-07-02T11:00:00.000Z");
      assert.equal(timeRangeToSinceISO("7d"), "2026-06-25T12:00:00.000Z");
      assert.equal(timeRangeToSinceISO("bad"), "");
    } finally {
      Date.now = originalNow;
    }

    assert.equal(
      approvalWorkflowLabel({ capabilityName: "Research", capabilitySlug: "research" }),
      "Research (research)"
    );
    assert.equal(approvalWorkflowLabel({ payload: { capability: "fallback-cap" } }), "fallback-cap");
  });
});

describe("run event helpers", () => {
  it("classifies event categories and severities", () => {
    assert.equal(eventCategoryClient({ type: "runner.heartbeat" }), "noise");
    assert.equal(eventCategoryClient({ type: "approval.created" }), "approval");
    assert.equal(eventCategoryClient({ type: "workflow.step" }), "step");
    assert.equal(eventCategoryClient({ type: "stdout" }), "log");
    assert.equal(eventCategoryClient({ type: "claude.final" }), "agent");
    assert.equal(eventSeverityClient({ type: "stderr" }), "error");
    assert.equal(eventSeverityClient({ type: "run.cancelled" }), "warn");
    assert.equal(eventSeverityClient({ type: "log", message: "retrying after warning" }), "warn");
    assert.equal(eventSeverityClient({ type: "log", message: "fatal exception" }), "error");
    assert.equal(eventSeverityClient({ type: "log", message: "all good" }), "info");
  });

  it("extracts node labels, dumps log text, and decorates raw events", () => {
    assert.equal(eventNodeClient({ data: { nodeId: "node_123" } }), "node_123");
    assert.equal(eventNodeClient({ data: null }), "");
    assert.equal(
      runLogTextDump([{ createdAt: "2026-07-02T12:00:00.000Z", type: "log", message: "hello" }]),
      "[2026-07-02T12:00:00.000Z] log: hello"
    );
    assert.deepEqual(
      decorateEvent({ id: "evt_1", type: "approval.created", message: "needs approval", data: { task: "review" } }),
      {
        id: "evt_1",
        type: "approval.created",
        message: "needs approval",
        data: { task: "review" },
        category: "approval",
        severity: "info",
        node: "review"
      }
    );
  });
});
