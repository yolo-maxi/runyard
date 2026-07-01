import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSmithersRunRegistry,
  isHubTerminalStatus,
  launchSmithers,
  parseSmithersRunId,
  smithersCommand,
  smithersLaunchRequest,
  supervisorChildEnv
} from "../src/runnerSmithersRuntime.js";

describe("runner Smithers runtime helpers", () => {
  it("builds direct and wrapped Smithers commands", () => {
    assert.deepEqual(smithersCommand({ smithersBin: "smithers" }, ["inspect", "run-1"]), {
      cmd: "smithers",
      args: ["inspect", "run-1"]
    });
    assert.deepEqual(smithersCommand({ smithersBin: "smithers", execWrapper: ["env", "-i"] }, ["events"]), {
      cmd: "env",
      args: ["-i", "smithers", "events"]
    });
  });

  it("builds launch requests with stdin for large input and strips resume markers", () => {
    const request = smithersLaunchRequest({
      entry: "workflow.tsx",
      input: { prompt: "x".repeat(80), __resume: { smithersRunId: "old" } },
      workspace: "/tmp/ws",
      resume: { smithersRunId: "run-1" },
      maxInlineInputBytes: 10
    });

    assert.deepEqual(request.args, [
      "up",
      "/tmp/ws/workflow.tsx",
      "--input",
      "-",
      "-d",
      "--format",
      "json",
      "--resume",
      "run-1",
      "--force"
    ]);
    assert.match(request.stdin, /"prompt"/);
    assert.doesNotMatch(request.stdin, /__resume/);
  });

  it("treats every Hub terminal status as a stop signal", () => {
    for (const status of [
      "succeeded",
      "failed",
      "blocked_by_preflight",
      "provider_limited",
      "timed_out",
      "invalid_output",
      "infra_unavailable",
      "needs_human",
      "cancelled"
    ]) {
      assert.equal(isHubTerminalStatus(status), true, status);
    }
    assert.equal(isHubTerminalStatus("running"), false);
    assert.equal(isHubTerminalStatus("assigned"), false);
  });

  it("tracks owned detached Smithers runs and cancels them deterministically", async () => {
    const cancelled = [];
    const events = [];
    const registry = createSmithersRunRegistry({
      cancelSmithersRun: async (...args) => {
        cancelled.push(args);
        return true;
      },
      event: async (...args) => events.push(args)
    });

    registry.register("run_1", "smithers_1");
    registry.register("run_2", "smithers_2");
    assert.equal(registry.active.size, 2);

    assert.equal(await registry.cancelRun("run_1", "operator cancelled"), true);
    assert.deepEqual(cancelled[0], ["smithers_1", "operator cancelled"]);
    assert.equal(events[0][1], "runner.cancel_smithers");

    registry.unregister("run_1");
    assert.equal(registry.active.size, 1);
    assert.equal(await registry.cancelAll("shutdown"), 1);
    assert.deepEqual(cancelled[1], ["smithers_2", "shutdown"]);
  });

  it("builds supervisor child env with explicit hub URL/token and secret override precedence", () => {
    const env = supervisorChildEnv({
      baseEnv: { BASE: "1" },
      token: "hub-token",
      baseUrl: "http://hub",
      claudeOauthToken: "local-oauth",
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth", API_KEY: "secret" }
    });

    assert.equal(env.BASE, "1");
    assert.equal(env.RUN_SMITHERS_HUB_TOKEN, "hub-token");
    assert.equal(env.RUN_SMITHERS_HUB_URL, "http://hub");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "secret-oauth");
    assert.equal(env.API_KEY, "secret");
  });

  it("parses run ids from json or text output", () => {
    assert.equal(parseSmithersRunId('{"runId":"run_json"}'), "run_json");
    assert.equal(parseSmithersRunId("started run-12345"), "run-12345");
    assert.throws(() => parseSmithersRunId("no id"), /could not determine smithers runId/);
  });

  it("launches through an injected Smithers runner", async () => {
    const calls = [];
    const id = await launchSmithers({
      runSmithers: async (args, opts) => {
        calls.push({ args, opts });
        return { stdout: '{"runId":"run_launched"}' };
      },
      entry: "/abs/workflow.tsx",
      input: { prompt: "hello" },
      workspace: "/tmp/ws",
      maxInlineInputBytes: 1000,
      token: "hub-token",
      baseUrl: "http://hub",
      runEnv: { RUNYARD_RUN_ID: "run_hub_1" }
    });

    assert.equal(id, "run_launched");
    assert.deepEqual(calls[0].args.slice(0, 2), ["up", "/abs/workflow.tsx"]);
    assert.equal(calls[0].opts.env.RUN_SMITHERS_HUB_TOKEN, "hub-token");
    assert.equal(calls[0].opts.env.RUNYARD_RUN_ID, "run_hub_1");
  });
});
