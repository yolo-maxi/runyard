import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSupportAgentRunnerProvider,
  __test
} from "../src/supportAgentRunnerProvider.js";

function harness(overrides = {}) {
  const events = [];
  const created = [];
  const run = overrides.run || {
    id: "run_1",
    status: "succeeded",
    output: { outputs: { support: { reply: "done" } } }
  };
  const call = createSupportAgentRunnerProvider({
    addRunEvent: (id, type, message, payload) => events.push({ id, type, message, payload }),
    createRun: (capability, input, options) => {
      created.push({ capability, input, options });
      return { id: "run_1" };
    },
    getCapability: () => Object.hasOwn(overrides, "capability")
      ? overrides.capability
      : { slug: "runyard-support-agent", enabled: true },
    getRun: () => overrides.getRun?.() ?? run,
    supportRunnerAvailability: () => overrides.runner ?? { available: true },
    sleep: async (ms) => overrides.sleeps?.push(ms),
    now: overrides.now || (() => Date.now())
  });
  return { call, created, events };
}

describe("support agent runner provider", () => {
  it("queues support chats with origin metadata and returns runner replies", async () => {
    const { call, created, events } = harness();

    const result = await call({ timeoutMs: 1000 }, {
      system: "system",
      messages: [{ role: "user", content: "help" }],
      context: { view: "runs" }
    });

    assert.deepEqual(result, {
      reply: "done",
      raw: { runId: "run_1", status: "succeeded" }
    });
    assert.equal(created[0].capability.slug, "runyard-support-agent");
    assert.deepEqual(created[0].input, {
      system: "system",
      messages: [{ role: "user", content: "help" }],
      context: { view: "runs" },
      __origin: { type: "support-chat", label: "Runyard support chat" }
    });
    assert.deepEqual(created[0].options, {
      requestedBy: "support-chat",
      origin: { type: "support-chat", label: "Runyard support chat" }
    });
    assert.deepEqual(events[0], {
      id: "run_1",
      type: "support_chat.queued",
      message: "Queued Runyard support agent chat",
      payload: { turns: 1, view: "runs" }
    });
  });

  it("surfaces runner setup and terminal failures", async () => {
    await assert.rejects(
      harness({ capability: null }).call({ timeoutMs: 1000 }, { messages: [], system: "", context: {} }),
      /support agent runner capability is not installed/
    );
    await assert.rejects(
      harness({ runner: { available: false, reason: "offline" } }).call({ timeoutMs: 1000 }, {
        messages: [],
        system: "",
        context: {}
      }),
      /support agent runner unavailable: offline/
    );
    await assert.rejects(
      harness({ run: { id: "run_1", status: "failed", error: "bad ".repeat(100) } }).call({ timeoutMs: 1000 }, {
        messages: [],
        system: "",
        context: {}
      }),
      /support agent run failed: bad bad/
    );
  });

  it("uses the documented polling backoff before timing out", async () => {
    let ticks = 0;
    const sleeps = [];
    const { call } = harness({
      sleeps,
      getRun: () => ({ id: "run_1", status: "running" }),
      now: () => {
        ticks += 1;
        return ticks * 100;
      }
    });

    await assert.rejects(
      call({ timeoutMs: 350 }, { messages: [], system: "", context: {} }),
      /support agent timed out/
    );

    assert.deepEqual(sleeps, [75, 75, 75]);
  });

  it("keeps support chat payload helpers small and stable", () => {
    assert.deepEqual(__test.supportChatQueuedEvent({
      messages: [{}, {}],
      context: {}
    }), { turns: 2, view: "" });
  });
});
