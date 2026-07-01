import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleRunnerSpecialRun } from "../src/runnerSpecialRuns.js";

function createHarness() {
  const calls = [];
  return {
    calls,
    client: {
      post: async (url, body) => {
        calls.push({ fn: "post", url, body });
        return {};
      }
    },
    event: async (...args) => calls.push({ fn: "event", args }),
    failRun: async (...args) => calls.push({ fn: "failRun", args })
  };
}

describe("runner special run handler", () => {
  it("handles reauth runs and streams verification events", async () => {
    const harness = createHarness();
    const handled = await handleRunnerSpecialRun({
      capability: { slug: "reauth-cli" },
      run: { id: "run_1", input: { provider: "codex" } },
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      runnerName: "runner-a",
      runnerId: "runner_1",
      client: harness.client,
      event: harness.event,
      failRun: harness.failRun,
      log: () => {},
      isReauthEnabled: () => true,
      runReauthFn: async (_input, options) => {
        await options.onVerification({ verificationUrl: "https://login.example", userCode: "ABCD" });
        return { status: "ok", provider: "codex" };
      },
      isSupportWarmEnabled: () => false
    });

    assert.equal(handled, true);
    assert.equal(harness.calls[0].fn, "event");
    assert.equal(harness.calls[1].url, "/api/runs/run_1/events");
    assert.equal(harness.calls.at(-1).url, "/api/runs/run_1/complete");
    assert.equal(harness.calls.some((call) => call.fn === "failRun"), false);
  });

  it("fails reauth runs when the provider reports an error", async () => {
    const harness = createHarness();
    const handled = await handleRunnerSpecialRun({
      capability: { slug: "reauth-cli" },
      run: { id: "run_1", input: { provider: "claude" } },
      runnerName: "runner-a",
      runnerId: "runner_1",
      client: harness.client,
      event: harness.event,
      failRun: harness.failRun,
      log: () => {},
      isReauthEnabled: () => true,
      runReauthFn: async () => ({ status: "failed", error: "setup failed" }),
      isSupportWarmEnabled: () => false
    });

    assert.equal(handled, true);
    assert.deepEqual(harness.calls.find((call) => call.fn === "failRun").args, ["run_1", "setup failed"]);
  });

  it("handles warm support runs with the existing output shape", async () => {
    const harness = createHarness();
    const handled = await handleRunnerSpecialRun({
      capability: { slug: "runyard-support-agent" },
      run: { id: "run_2", input: { messages: [] } },
      runnerName: "support-runner",
      runnerId: "runner_2",
      client: harness.client,
      event: harness.event,
      failRun: harness.failRun,
      log: () => {},
      isReauthEnabled: () => false,
      isSupportWarmEnabled: () => true,
      warmSupportReplyFn: async () => "hello"
    });

    assert.equal(handled, true);
    assert.equal(harness.calls[0].args[1], "runner.warm_support");
    assert.deepEqual(harness.calls.at(-1).body, { output: { outputs: { support: { reply: "hello" } } } });
  });

  it("returns false for ordinary Smithers workflow runs", async () => {
    const harness = createHarness();
    const handled = await handleRunnerSpecialRun({
      capability: { slug: "hello" },
      run: { id: "run_3", input: {} },
      runnerName: "runner",
      runnerId: "runner_3",
      client: harness.client,
      event: harness.event,
      failRun: harness.failRun,
      log: () => {},
      isReauthEnabled: () => true,
      isSupportWarmEnabled: () => true
    });

    assert.equal(handled, false);
    assert.deepEqual(harness.calls, []);
  });
});
