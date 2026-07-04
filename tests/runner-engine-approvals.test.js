import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_APPROVAL_APPLIED_EVENT,
  ENGINE_APPROVAL_APPLY_FAILED_EVENT,
  ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS,
  ENGINE_APPROVAL_RESUMED_EVENT,
  ENGINE_APPROVAL_WAITING_EVENT,
  createEngineApprovalBridge,
  engineApprovalCardRequest,
  engineApprovalCliArgs,
  engineApprovalWaits,
  engineDecisionFromEventLine
} from "../src/runnerEngineApprovals.js";

const WAITING_INSPECT = {
  run: { id: "run_sm1", status: "waiting-approval" },
  runState: { state: "waiting-approval" },
  approvals: [{ nodeId: "ship-gate", status: "pending", requestedAt: "2026-07-04T00:00:00.000Z" }]
};

const RUNNING_INSPECT = { run: { id: "run_sm1", status: "running" }, runState: { state: "running" } };

describe("engineApprovalWaits", () => {
  it("extracts pending engine approval nodes from inspect JSON", () => {
    assert.deepEqual(engineApprovalWaits(WAITING_INSPECT), [
      { nodeId: "ship-gate", requestedAt: "2026-07-04T00:00:00.000Z" }
    ]);
  });

  it("returns no waits for a running workflow", () => {
    assert.deepEqual(engineApprovalWaits(RUNNING_INSPECT), []);
    assert.deepEqual(engineApprovalWaits(null), []);
    assert.deepEqual(engineApprovalWaits({}), []);
  });

  it("synthesizes an empty-node wait when the engine reports waiting-approval without an approvals array", () => {
    assert.deepEqual(engineApprovalWaits({ run: { status: "waiting-approval" } }), [{ nodeId: "", requestedAt: "" }]);
  });

  it("ignores non-pending approval rows", () => {
    assert.deepEqual(
      engineApprovalWaits({
        run: { status: "running" },
        approvals: [{ nodeId: "done-gate", status: "approved" }]
      }),
      []
    );
  });
});

describe("engineApprovalCardRequest", () => {
  it("builds a blocking engine_approval card tied to the hub run", () => {
    const body = engineApprovalCardRequest({
      hubRunId: "run_hub1",
      smithersRunId: "run_sm1",
      nodeId: "ship-gate",
      capabilitySlug: "improve",
      runnerName: "hetzner (vps)"
    });
    assert.equal(body.runId, "run_hub1");
    assert.match(body.title, /Engine approval: improve · ship-gate/);
    assert.equal(body.payload.kind, "engine_approval");
    assert.equal(body.payload.smithersRunId, "run_sm1");
    assert.equal(body.payload.nodeId, "ship-gate");
    // Blocking by contract: no timer fields on engine approval cards.
    assert.equal("timeoutMs" in body, false);
    assert.equal("fallback" in body, false);
  });
});

describe("engineApprovalCliArgs", () => {
  it("maps approved to smithers approve with node and approver", () => {
    assert.deepEqual(
      engineApprovalCliArgs({ decision: "approved", smithersRunId: "run_sm1", nodeId: "gate", resolvedBy: "ocean" }),
      ["approve", "run_sm1", "--node", "gate", "--by", "ocean"]
    );
  });

  it("maps rejected and changes_requested to smithers deny", () => {
    assert.equal(engineApprovalCliArgs({ decision: "rejected", smithersRunId: "run_sm1" })[0], "deny");
    assert.equal(engineApprovalCliArgs({ decision: "changes_requested", smithersRunId: "run_sm1" })[0], "deny");
  });

  it("never invents an engine decision for unknown card outcomes", () => {
    assert.equal(engineApprovalCliArgs({ decision: "shrug", smithersRunId: "run_sm1" }), null);
    assert.equal(engineApprovalCliArgs({ decision: "approved", smithersRunId: "" }), null);
  });
});

describe("engineDecisionFromEventLine", () => {
  it("recognizes engine-side approval decisions in NDJSON event lines", () => {
    assert.deepEqual(
      engineDecisionFromEventLine(JSON.stringify({ type: "ApprovalGranted", payload: { nodeId: "gate" } })),
      { nodeId: "gate", decision: "approved" }
    );
    assert.deepEqual(
      engineDecisionFromEventLine(JSON.stringify({ type: "ApprovalAutoApproved", payload: { nodeId: "gate" } })),
      { nodeId: "gate", decision: "approved" }
    );
    assert.deepEqual(
      engineDecisionFromEventLine(JSON.stringify({ type: "ApprovalDenied", payload: { nodeId: "gate" } })),
      { nodeId: "gate", decision: "rejected" }
    );
  });

  it("ignores unrelated and malformed lines", () => {
    assert.equal(engineDecisionFromEventLine(JSON.stringify({ type: "NodeFinished", payload: {} })), null);
    assert.equal(engineDecisionFromEventLine("not json"), null);
  });
});

function bridgeHarness({ hubPostImpl, hubGetImpl, runSmithersImpl } = {}) {
  const events = [];
  const hubPosts = [];
  const cliCalls = [];
  const bridge = createEngineApprovalBridge({
    hubRunId: "run_hub1",
    smithersRunId: "run_sm1",
    capabilitySlug: "improve",
    runnerName: "hetzner (vps)",
    postEvent: async (type, message, data) => events.push({ type, message, data }),
    hubGet: hubGetImpl || (async () => ({ approval: { id: "appr_1", status: "pending" } })),
    hubPost:
      hubPostImpl ||
      (async (pathname, body) => {
        hubPosts.push({ pathname, body });
        return { approval: { id: "appr_1", status: "pending" } };
      }),
    runSmithers:
      runSmithersImpl ||
      (async (args) => {
        cliCalls.push(args);
        return { stdout: "" };
      }),
    logError: () => {}
  });
  return { bridge, events, hubPosts, cliCalls };
}

describe("createEngineApprovalBridge", () => {
  it("surfaces a new engine wait as a run event plus a hub approval card, once", async () => {
    const { bridge, events, hubPosts } = bridgeHarness();
    await bridge.tick(WAITING_INSPECT);
    await bridge.tick(WAITING_INSPECT);

    const waiting = events.filter((event) => event.type === ENGINE_APPROVAL_WAITING_EVENT);
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0].data, { smithersRunId: "run_sm1", nodeId: "ship-gate" });
    assert.equal(hubPosts.length, 1);
    assert.equal(hubPosts[0].pathname, "/api/approvals");
    assert.equal(hubPosts[0].body.payload.kind, "engine_approval");
  });

  it("still emits the waiting event when card creation fails (event-based hold protects the run)", async () => {
    const { bridge, events } = bridgeHarness({
      hubPostImpl: async () => {
        throw new Error("hub unreachable");
      }
    });
    await bridge.tick(WAITING_INSPECT);
    assert.equal(events.filter((event) => event.type === ENGINE_APPROVAL_WAITING_EVENT).length, 1);
  });

  it("applies a resolved card decision to the engine via smithers approve", async () => {
    let resolved = false;
    const { bridge, events, cliCalls } = bridgeHarness({
      hubGetImpl: async () => ({
        approval: resolved
          ? { id: "appr_1", status: "approved", decision: "approved", resolvedBy: "ocean", comment: "ship it" }
          : { id: "appr_1", status: "pending" }
      })
    });
    await bridge.tick(WAITING_INSPECT);
    await bridge.tick(WAITING_INSPECT);
    assert.equal(cliCalls.length, 0);

    resolved = true;
    await bridge.tick(WAITING_INSPECT);
    assert.equal(cliCalls.length, 1);
    assert.deepEqual(cliCalls[0].slice(0, 4), ["approve", "run_sm1", "--node", "ship-gate"]);
    const applied = events.filter((event) => event.type === ENGINE_APPROVAL_APPLIED_EVENT);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].data.decision, "approved");

    // Decision applied once; later ticks while the engine catches up do not re-run the CLI.
    await bridge.tick(WAITING_INSPECT);
    assert.equal(cliCalls.length, 1);
  });

  it("gives up after bounded CLI failures and reports each attempt", async () => {
    const { bridge, events } = bridgeHarness({
      hubGetImpl: async () => ({
        approval: { id: "appr_1", status: "approved", decision: "approved", resolvedBy: "ocean" }
      }),
      runSmithersImpl: async () => {
        throw new Error("NO_PENDING_APPROVALS");
      }
    });
    for (let i = 0; i < ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS + 2; i++) await bridge.tick(WAITING_INSPECT);
    const failures = events.filter((event) => event.type === ENGINE_APPROVAL_APPLY_FAILED_EVENT);
    assert.equal(failures.length, ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS);
    assert.match(failures.at(-1).message, /giving up/);
  });

  it("emits engine.approval.resumed with the engine-side decision when the wait clears", async () => {
    const { bridge, events } = bridgeHarness();
    await bridge.tick(WAITING_INSPECT);
    bridge.observeEventLine(JSON.stringify({ type: "ApprovalGranted", payload: { nodeId: "ship-gate" } }));
    await bridge.tick(RUNNING_INSPECT);

    const resumed = events.filter((event) => event.type === ENGINE_APPROVAL_RESUMED_EVENT);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].data.nodeId, "ship-gate");
    assert.equal(resumed[0].data.engineDecision, "approved");
  });

  it("tracks multiple concurrent gates independently", async () => {
    const both = {
      run: { status: "waiting-approval" },
      approvals: [
        { nodeId: "gate-a", status: "pending" },
        { nodeId: "gate-b", status: "pending" }
      ]
    };
    const onlyB = { run: { status: "waiting-approval" }, approvals: [{ nodeId: "gate-b", status: "pending" }] };
    const { bridge, events } = bridgeHarness();
    await bridge.tick(both);
    await bridge.tick(onlyB);

    assert.equal(events.filter((event) => event.type === ENGINE_APPROVAL_WAITING_EVENT).length, 2);
    const resumed = events.filter((event) => event.type === ENGINE_APPROVAL_RESUMED_EVENT);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].data.nodeId, "gate-a");
  });
});
