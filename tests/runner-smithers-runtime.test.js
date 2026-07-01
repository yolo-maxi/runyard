import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
      baseUrl: "http://hub"
    });

    assert.equal(id, "run_launched");
    assert.deepEqual(calls[0].args.slice(0, 2), ["up", "/abs/workflow.tsx"]);
    assert.equal(calls[0].opts.env.RUN_SMITHERS_HUB_TOKEN, "hub-token");
  });
});
