import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWatcherState,
  recordChildAttempt,
  recordRepairAttempt,
  watcherSummary
} from "../src/runSmithersState.js";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  RUN_SMITHERS_LINEAGE_SCHEMA_VERSION
} from "../src/runSmithersPolicy.js";

describe("run-smithers watcher state helpers", () => {
  it("creates bounded watcher state with input key summaries", () => {
    const state = createWatcherState({
      parentRunId: "parent",
      capabilitySlug: "hello",
      goal: "ship",
      input: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index])),
      maxAttempts: 0,
      fingerprintThreshold: 0,
      maxCodeRepairs: -1
    });

    assert.equal(state.schemaVersion, RUN_SMITHERS_LINEAGE_SCHEMA_VERSION);
    assert.equal(state.parentRunId, "parent");
    assert.equal(state.inputKeys.length, 32);
    assert.equal(state.maxAttempts, RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS);
    assert.equal(state.fingerprintThreshold, RUN_SMITHERS_FINGERPRINT_LIMIT);
    assert.equal(state.maxCodeRepairs, 0);
    assert.equal(createWatcherState({}).maxCodeRepairs, RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS);
  });

  it("records child attempts with normalized fingerprints and failure classes", () => {
    const state = createWatcherState({ capabilitySlug: "hello" });
    const first = recordChildAttempt(state, {
      runId: "run_1",
      status: "failed",
      error: "boom in /tmp/runyard-aaaa at 2026-06-30T00:00:00.000Z",
      failedStep: "build"
    });
    const second = recordChildAttempt(state, {
      runId: "run_2",
      status: "failed",
      error: "boom in /tmp/runyard-bbbb at 2026-06-30T00:00:01.000Z"
    });

    assert.equal(first.failureClass, "failed");
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(state.fingerprintCounts[first.fingerprint], 2);
    assert.equal(state.lastFingerprint, first.fingerprint);
  });

  it("records repair attempts and builds summary lineage", () => {
    const state = createWatcherState({ capabilitySlug: "hello", parentRunId: "parent" });
    recordChildAttempt(state, { runId: "run_1", status: "failed", error: "TypeError: bad", failedStep: "dispatch" });
    const repair = recordRepairAttempt(state, {
      file: "workflow.tsx",
      failedStep: "dispatch",
      ok: true,
      testPassed: true,
      synced: true,
      notes: "x".repeat(700),
      recordedAt: "2026-06-30T00:00:00.000Z"
    });
    state.approvalRequested = true;

    const summary = watcherSummary(state);
    assert.equal(repair.notes.length, 600);
    assert.equal(state.codeRepairs, 1);
    assert.equal(summary.parentRunId, "parent");
    assert.equal(summary.attempts, 1);
    assert.equal(summary.approvalRequested, true);
    assert.equal(summary.repairs[0].file, "workflow.tsx");
    assert.equal(summary.lineage[0].runId, "run_1");
    assert.equal(watcherSummary(null), null);
  });
});
