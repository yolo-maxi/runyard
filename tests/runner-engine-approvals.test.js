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
      { nodeId: "ship-gate", requestedAt: "2026-07-04T00:00:00.000Z", title: "", summary: "", metadata: null }
    ]);
  });

  it("carries the gate's authored request when the engine exposes it (≥0.25 inspect)", () => {
    const waits = engineApprovalWaits({
      runState: { state: "waiting-approval" },
      approvals: [
        {
          nodeId: "skin:approval",
          status: "pending",
          requestedAt: "2026-07-04T00:00:00.000Z",
          request: {
            title: "Approve app skin direction",
            summary: "4 skins proposed; recommendation: Neon Tide",
            metadata: { skinCount: 4 }
          }
        }
      ]
    });
    assert.equal(waits[0].title, "Approve app skin direction");
    assert.equal(waits[0].summary, "4 skins proposed; recommendation: Neon Tide");
    assert.deepEqual(waits[0].metadata, { skinCount: 4 });
  });

  it("returns no waits for a running workflow", () => {
    assert.deepEqual(engineApprovalWaits(RUNNING_INSPECT), []);
    assert.deepEqual(engineApprovalWaits(null), []);
    assert.deepEqual(engineApprovalWaits({}), []);
  });

  it("synthesizes an empty-node wait when the engine reports waiting-approval without an approvals array", () => {
    assert.deepEqual(engineApprovalWaits({ run: { status: "waiting-approval" } }), [
      { nodeId: "", requestedAt: "", title: "", summary: "", metadata: null }
    ]);
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

  it("accepts the 0.30 'requested' status alongside 0.22's 'pending'", () => {
    // Verified against a live 0.30 gate: inspect reports approvals[] rows with
    // status "requested" — the 0.22 filter for "pending" alone would see zero
    // pending gates and leave the run unbridged.
    const waits = engineApprovalWaits({
      run: { id: "run_sm1", status: "waiting-approval" },
      runState: { state: "waiting-approval" },
      approvals: [{ nodeId: "confirm", status: "requested", requestedAt: "2026-07-23T01:29:18.017Z" }]
    });
    assert.equal(waits.length, 1);
    assert.equal(waits[0].nodeId, "confirm");
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
    assert.match(body.title, /Workflow gate: improve · ship-gate/);
    assert.equal(body.payload.kind, "engine_approval");
    assert.equal(body.payload.smithersRunId, "run_sm1");
    assert.equal(body.payload.nodeId, "ship-gate");
    // Even generic cards declare an ask (the contract), and the smithers CLI
    // incantation is ops payload detail, never human-facing description copy.
    assert.match(body.ask.action, /ship-gate/);
    assert.ok(body.ask.reason);
    assert.doesNotMatch(body.description, /smithers approve/);
    assert.match(body.payload.engineCli, /smithers approve\|deny run_sm1 --node ship-gate/);
    // Blocking by contract: no timer fields on engine approval cards.
    assert.equal("timeoutMs" in body, false);
    assert.equal("fallback" in body, false);
  });

  it("preserves the gate's authored title and summary instead of generic boilerplate", () => {
    const body = engineApprovalCardRequest({
      hubRunId: "run_hub1",
      smithersRunId: "run_sm1",
      nodeId: "skin:approval",
      capabilitySlug: "app-skinner",
      runnerName: "vps",
      wait: {
        nodeId: "skin:approval",
        title: "Approve app skin direction",
        summary: "4 skins proposed; recommendation: Neon Tide",
        metadata: { skinCount: 4 }
      }
    });
    assert.equal(body.title, "Approve app skin direction");
    assert.equal(body.description, "4 skins proposed; recommendation: Neon Tide");
    assert.deepEqual(body.payload.request, {
      title: "Approve app skin direction",
      summary: "4 skins proposed; recommendation: Neon Tide",
      metadata: { skinCount: 4 }
    });
    // The authored summary doubles as the ask's reason when no seed ask exists.
    assert.equal(body.ask.reason, "4 skins proposed; recommendation: Neon Tide");
  });

  it("falls back to the seed-registered gate ask when the engine exposes no request (0.22)", () => {
    const body = engineApprovalCardRequest({
      hubRunId: "run_hub1",
      smithersRunId: "run_sm1",
      nodeId: "skin:approval",
      capabilitySlug: "app-skinner",
      runnerName: "vps",
      wait: { nodeId: "skin:approval", title: "", summary: "", metadata: null },
      gateAsk: {
        title: "Approve app skin direction",
        action: "Pick the proposed visual skin direction.",
        reason: "The skin direction shapes all downstream design work.",
        summary: "The workflow proposed several skins and paused for a human choice."
      }
    });
    assert.equal(body.title, "Approve app skin direction");
    assert.equal(body.description, "The workflow proposed several skins and paused for a human choice.");
    assert.equal(body.ask.action, "Pick the proposed visual skin direction.");
    assert.equal(body.ask.reason, "The skin direction shapes all downstream design work.");
  });

  it("prefers the authored request over the seed ask when both exist", () => {
    const body = engineApprovalCardRequest({
      nodeId: "gate",
      smithersRunId: "run_sm1",
      wait: { nodeId: "gate", title: "Authored title", summary: "Authored summary" },
      gateAsk: { title: "Seed title", summary: "Seed summary", action: "Seed action", reason: "Seed reason" }
    });
    assert.equal(body.title, "Authored title");
    assert.equal(body.description, "Authored summary");
    // The seed ask still supplies the declared action/reason when present.
    assert.equal(body.ask.action, "Seed action");
    assert.equal(body.ask.reason, "Seed reason");
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

function bridgeHarness({ hubPostImpl, hubGetImpl, runSmithersImpl, resumeEngineRunImpl } = {}) {
  const events = [];
  const hubPosts = [];
  const cliCalls = [];
  const resumeCalls = [];
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
    resumeEngineRun:
      resumeEngineRunImpl === null
        ? null
        : resumeEngineRunImpl ||
          (async () => {
            resumeCalls.push(Date.now());
            return "run_sm1";
          }),
    logError: () => {}
  });
  return { bridge, events, hubPosts, cliCalls, resumeCalls };
}

// 0.30 detached semantics: once the last gate is decided the run parks as
// `waiting-event` with no pending approvals and an exited owner process.
const WAITING_EVENT_INSPECT = { run: { id: "run_sm1", status: "waiting-event" }, runState: { state: "waiting-event" } };

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

  it("relaunches the parked run after a Hub-applied decision (0.30 waiting-event)", async () => {
    let resolved = false;
    const { bridge, events, cliCalls, resumeCalls } = bridgeHarness({
      hubGetImpl: async () => ({
        approval: resolved
          ? { id: "appr_1", status: "approved", decision: "approved", resolvedBy: "ocean" }
          : { id: "appr_1", status: "pending" }
      })
    });
    await bridge.tick(WAITING_INSPECT);
    resolved = true;
    await bridge.tick(WAITING_INSPECT);
    assert.equal(cliCalls.length, 1, "decision applied via smithers approve");
    assert.equal(resumeCalls.length, 0, "no resume while the gate is still pending engine-side");

    // Engine processed the decision: gate gone, run parked waiting-event with
    // its owner process exited — the bridge must relaunch from the checkpoint.
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(resumeCalls.length, 1);
    const resumedLaunch = events.filter((event) => event.type === ENGINE_APPROVAL_RESUMED_EVENT && event.data.resumeLaunch);
    assert.equal(resumedLaunch.length, 1);

    // The resume fires once per decided round, not on every later tick.
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(resumeCalls.length, 1);
  });

  it("relaunches after an engine-side decision observed in the event stream", async () => {
    const { bridge, resumeCalls } = bridgeHarness();
    await bridge.tick(WAITING_INSPECT);
    bridge.observeEventLine(JSON.stringify({ type: "ApprovalGranted", payload: { nodeId: "ship-gate" } }));
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(resumeCalls.length, 1);
  });

  it("never relaunches a waiting-event run without a decided gate (Signal/WaitForEvent waits)", async () => {
    const { bridge, resumeCalls } = bridgeHarness();
    await bridge.tick(WAITING_EVENT_INSPECT);
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(resumeCalls.length, 0);
  });

  it("retries the resume launch on the next tick when it fails", async () => {
    let attempts = 0;
    const { bridge, events } = bridgeHarness({
      resumeEngineRunImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("launch race");
        return "run_sm1";
      }
    });
    await bridge.tick(WAITING_INSPECT);
    bridge.observeEventLine(JSON.stringify({ type: "ApprovalGranted", payload: { nodeId: "ship-gate" } }));
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(attempts, 1);
    assert.ok(events.some((event) => event.type === ENGINE_APPROVAL_APPLY_FAILED_EVENT && event.data.resumeLaunch));
    await bridge.tick(WAITING_EVENT_INSPECT);
    assert.equal(attempts, 2, "failed resume retried on the next tick");
  });

  it("quotes the authored request from ApprovalRequested events on the Hub card (0.30)", async () => {
    // inspect never carries the authored <Approval request>; on 0.30 it
    // arrives via ApprovalRequested/NodeWaitingApproval events instead.
    const { bridge, hubPosts } = bridgeHarness();
    bridge.observeEventLine(
      JSON.stringify({
        type: "ApprovalRequested",
        payload: {
          nodeId: "ship-gate",
          request: { mode: "decision", title: "Ship the release?", summary: "All gates green.", metadata: {} }
        }
      })
    );
    await bridge.tick(WAITING_INSPECT);
    assert.equal(hubPosts.length, 1);
    assert.equal(hubPosts[0].body.title, "Ship the release?");
    assert.equal(hubPosts[0].body.description, "All gates green.");
    assert.equal(hubPosts[0].body.payload.request.title, "Ship the release?");
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
