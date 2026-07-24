import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSmithersRunRegistry,
  isHubTerminalStatus,
  launchSmithers,
  parseSmithersRunId,
  resumeCheckpointMissingMessage,
  resumeCheckpointStatus,
  smithersCommand,
  smithersEventsArgs,
  smithersLaunchFailure,
  smithersLaunchRequest,
  runyardChildEnv
} from "../src/runnerSmithersRuntime.js";

describe("runner Smithers runtime helpers", () => {
  it("builds a direct command when no exec wrapper is configured", () => {
    assert.deepEqual(smithersCommand({ smithersBin: "smithers" }, ["inspect", "run-1"]), {
      cmd: "smithers",
      args: ["inspect", "run-1"]
    });
    assert.deepEqual(smithersCommand({ smithersBin: "smithers" }, ["up", "/ws/wf.tsx"]), {
      cmd: "smithers",
      args: ["up", "/ws/wf.tsx"]
    });
  });

  it("wraps only the workflow launch (`up`) with the exec wrapper", () => {
    assert.deepEqual(
      smithersCommand({ smithersBin: "smithers", execWrapper: ["docker", "run", "--rm", "img"] }, [
        "up",
        "/ws/wf.tsx",
        "--input",
        "-"
      ]),
      {
        cmd: "docker",
        args: ["run", "--rm", "img", "smithers", "up", "/ws/wf.tsx", "--input", "-"]
      }
    );
  });

  it("never wraps polling/control commands, even with an exec wrapper set", () => {
    const execWrapper = ["docker", "run", "--rm", "img"];
    for (const args of [
      ["events", "run-1", "--json"],
      ["inspect", "run-1", "--format", "json"],
      ["output", "run-1", "node-1", "--json"],
      ["cancel", "run-1"]
    ]) {
      assert.deepEqual(
        smithersCommand({ smithersBin: "smithers", execWrapper }, args),
        { cmd: "smithers", args },
        `expected ${args[0]} to run unwrapped`
      );
    }
  });

  it("wraps the real launch argv produced by smithersLaunchRequest", () => {
    const request = smithersLaunchRequest({
      entry: "workflow.tsx",
      input: { prompt: "hi" },
      workspace: "/tmp/ws",
      maxInlineInputBytes: 1000
    });
    const command = smithersCommand({ smithersBin: "smithers", execWrapper: ["firejail", "--quiet"] }, request.args);
    assert.equal(command.cmd, "firejail");
    assert.deepEqual(command.args.slice(0, 4), ["--quiet", "smithers", "up", "/tmp/ws/workflow.tsx"]);
  });

  it("builds launch requests with stdin for large input and strips resume markers", () => {
    const request = smithersLaunchRequest({
      entry: "workflow.tsx",
      input: { prompt: "x".repeat(80), __resume: { smithersRunId: "old" } },
      workspace: "/tmp/ws",
      resume: { smithersRunId: "run-1" },
      maxInlineInputBytes: 10,
      hubRunId: "run_hub_1"
    });

    assert.deepEqual(request.args, [
      "up",
      "/tmp/ws/workflow.tsx",
      "--input",
      "-",
      "-d",
      "--format",
      "json",
      "--no-post-failure",
      "--started-by-harness",
      "runyard-runner",
      "--started-by-session",
      "run_hub_1",
      "--resume",
      "run-1",
      "--force"
    ]);
    assert.match(request.stdin, /"prompt"/);
    assert.doesNotMatch(request.stdin, /__resume/);
  });

  it("declares engine attribution and disables the post-failure autopsy on every launch", () => {
    // Without --started-by-* the 0.30 engine records whatever harness it
    // sniffs from the runner's environment (observed: "codex"); without
    // --no-post-failure a failed run spawns an unmanaged autopsy run.
    const request = smithersLaunchRequest({
      entry: "workflow.tsx",
      input: {},
      workspace: "/tmp/ws",
      maxInlineInputBytes: 1000
    });
    assert.ok(request.args.includes("--no-post-failure"));
    const harnessAt = request.args.indexOf("--started-by-harness");
    assert.notEqual(harnessAt, -1);
    assert.equal(request.args[harnessAt + 1], "runyard-runner");
    // No hub run id -> no session attribution rather than an empty value.
    assert.equal(request.args.includes("--started-by-session"), false);
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

  it("builds child env with explicit hub URL/token and secret override precedence", () => {
    const env = runyardChildEnv({
      baseEnv: { PATH: "/usr/bin", HOME: "/home/runner", SECRETS_ENC_KEY: "master-key", BASE: "1" },
      token: "hub-token",
      baseUrl: "http://hub",
      claudeOauthToken: "local-oauth",
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth", API_KEY: "secret" }
    });

    // Allowlisted OS/toolchain baseline still passes through.
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/runner");
    // Runner secrets and unlisted vars never reach the child.
    assert.equal(env.SECRETS_ENC_KEY, undefined);
    assert.equal(env.BASE, undefined);
    // Explicit hub / secret channels still work, secretEnv wins over the
    // locally-resolved oauth token.
    assert.equal(env.RUNYARD_HUB_TOKEN, "hub-token");
    assert.equal(env.RUNYARD_HUB_URL, "http://hub");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "secret-oauth");
    assert.equal(env.API_KEY, "secret");
  });

  it("passes non-secret repo selection config to Smithers workflows", () => {
    const env = runyardChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        IMPROVE_REPO_DIR: "/home/xiko/runyard",
        IMPROVE_ALLOWED_REPO_ROOTS: "/home/xiko/runyard,/home/xiko/skillmarket",
        IMPROVE_REPO_MAP: '{"skillmarket":"/home/xiko/skillmarket"}',
        SMITHERS_REPO_CATALOG: '[{"value":"skillmarket","label":"SkillMarket"}]',
        SMITHERS_HUB_TOKEN: "runner-token",
        TELEGRAM_BOT_TOKEN: "bot-token"
      }
    });

    assert.equal(env.IMPROVE_REPO_DIR, "/home/xiko/runyard");
    assert.equal(env.IMPROVE_ALLOWED_REPO_ROOTS, "/home/xiko/runyard,/home/xiko/skillmarket");
    assert.equal(env.IMPROVE_REPO_MAP, '{"skillmarket":"/home/xiko/skillmarket"}');
    assert.equal(env.SMITHERS_REPO_CATALOG, '[{"value":"skillmarket","label":"SkillMarket"}]');
    assert.equal(env.SMITHERS_HUB_TOKEN, undefined);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  });

  // A detached `smithers up --resume` only validates RUN_NOT_FOUND inside its
  // background child, so the runner must prove the checkpoint exists via
  // inspect BEFORE launching — otherwise a missing checkpoint hangs the poll
  // loop until the deadline fails the run hours later as a bogus timeout.
  it("resumeCheckpointStatus reports whether the local checkpoint is inspectable", async () => {
    const seen = [];
    const found = await resumeCheckpointStatus({
      inspectRun: async (sid) => {
        seen.push(sid);
        return { runState: { state: "cancelled" } };
      },
      smithersRunId: "run-777"
    });
    assert.deepEqual(found, { ok: true });
    assert.deepEqual(seen, ["run-777"]);

    const missing = await resumeCheckpointStatus({
      inspectRun: async () => {
        throw new Error("Run not found: run-777");
      },
      smithersRunId: "run-777"
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Run not found/);
  });

  it("resumeCheckpointMissingMessage names the checkpoint and the honest fallback", () => {
    const message = resumeCheckpointMissingMessage("run-777", "Run not found: run-777\n  at inspect");
    assert.match(message, /run-777/);
    assert.match(message, /\.smithers state/);
    assert.match(message, /re-run from scratch/);
    assert.match(message, /Run not found/);
    assert.ok(!message.includes("\n"), "detail is flattened for event/pause records");
    // Without detail the message still stands alone.
    assert.match(resumeCheckpointMissingMessage("run-8"), /re-paused/);
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
      baseEnv: {
        PATH: "/usr/bin",
        IMPROVE_ALLOWED_REPO_ROOTS: "/srv/runyard,/srv/skillmarket"
      },
      token: "hub-token",
      baseUrl: "http://hub",
      runEnv: { RUNYARD_RUN_ID: "run_hub_1" }
    });

    assert.equal(id, "run_launched");
    assert.deepEqual(calls[0].args.slice(0, 2), ["up", "/abs/workflow.tsx"]);
    assert.equal(calls[0].opts.env.RUNYARD_HUB_TOKEN, "hub-token");
    assert.equal(calls[0].opts.env.RUNYARD_RUN_ID, "run_hub_1");
    assert.equal(calls[0].opts.env.IMPROVE_ALLOWED_REPO_ROOTS, "/srv/runyard,/srv/skillmarket");
  });

  it("pins engine behavior off in the launch child env (daemon, update checks, autopsy)", () => {
    const env = runyardChildEnv({ baseEnv: { PATH: "/usr/bin" } });
    assert.equal(env.SMITHERS_NO_DAEMON, "1");
    assert.equal(env.SMITHERS_NO_UPDATE_CHECK, "1");
    assert.equal(env.SMITHERS_POST_FAILURE, "0");
    // Explicit run-level overrides still win over the defaults.
    const overridden = runyardChildEnv({ baseEnv: { PATH: "/usr/bin" }, runEnv: { SMITHERS_NO_DAEMON: "0" } });
    assert.equal(overridden.SMITHERS_NO_DAEMON, "0");
  });

  it("polls events with --raw so TokenUsageReported survives the ≥0.28 lifecycle filter", () => {
    // Without --raw, `smithers events` filters to lifecycle types and the
    // runner would silently stop seeing TokenUsageReported — usage metering
    // and budget enforcement would die without an error anywhere.
    assert.deepEqual(smithersEventsArgs("run-9"), ["events", "run-9", "--json", "--raw", "--limit", "100000"]);
  });

  it("extracts the 0.30 fail-fast launch envelope from stdout/stderr", () => {
    const envelope = JSON.stringify({
      code: "DETACHED_PREFLIGHT_FAILED",
      message: "/ws/broken.tsx:15:7: Syntax Error\n    </Task>\n      ^"
    });
    const fromStdout = smithersLaunchFailure({ stdout: envelope, stderr: "" });
    assert.equal(fromStdout.code, "DETACHED_PREFLIGHT_FAILED");
    assert.equal(fromStdout.preflight, true);
    assert.match(fromStdout.message, /broken\.tsx:15:7/);

    // Non-envelope failures stay untouched so unknown errors keep their shape.
    assert.equal(smithersLaunchFailure({ stdout: "boom", stderr: "no json here" }), null);
    assert.equal(smithersLaunchFailure(new Error("plain failure")), null);
  });

  it("launchSmithers surfaces the fail-fast envelope as a structured launch error", async () => {
    const error = new Error("smithers exited 1");
    error.stdout = '{"code":"DETACHED_PREFLIGHT_FAILED","message":"/ws/wf.tsx:3:1: Syntax Error"}';
    await assert.rejects(
      launchSmithers({
        runSmithers: async () => {
          throw error;
        },
        entry: "/ws/wf.tsx",
        input: {},
        workspace: "/ws",
        maxInlineInputBytes: 1000,
        baseEnv: { PATH: "/usr/bin" }
      }),
      (thrown) => {
        assert.match(thrown.message, /before a run id existed/);
        assert.match(thrown.message, /wf\.tsx:3:1/);
        assert.equal(thrown.smithersLaunchFailure.preflight, true);
        return true;
      }
    );
  });
});
