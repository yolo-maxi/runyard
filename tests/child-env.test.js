import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHILD_ENV_ALLOWLIST, allowlistedBaseEnv } from "../src/childEnv.js";
import { supervisorChildEnv } from "../src/runnerSmithersRuntime.js";

// A representative slice of what a real runner process carries: OS baseline the
// child legitimately needs, plus the runner's own secrets that must NEVER reach
// a launched workflow/agent.
const RUNNER_ENV = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/runner",
  LANG: "en_US.UTF-8",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  XDG_CONFIG_HOME: "/home/runner/.config",
  // Sensitive runner/hub secrets — the whole point of the allowlist is to drop these.
  SECRETS_ENC_KEY: "base64-master-key",
  RUNYARD_HUB_SESSION_SECRET: "hub-session-secret",
  RUNYARD_HUB_BOOTSTRAP_TOKEN: "bootstrap-token",
  RUNYARD_READ_TOKEN: "read-token",
  OPENAI_API_KEY: "sk-runner-openai",
  TELEGRAM_BOT_TOKEN: "telegram-bot",
  SMITHERS_OBSTRUCTION_ANALYSIS_API_KEY: "obstruction-key"
};

const SENSITIVE_KEYS = [
  "SECRETS_ENC_KEY",
  "RUNYARD_HUB_SESSION_SECRET",
  "RUNYARD_HUB_BOOTSTRAP_TOKEN",
  "RUNYARD_READ_TOKEN",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "SMITHERS_OBSTRUCTION_ANALYSIS_API_KEY"
];

describe("child env allowlist", () => {
  it("keeps only the OS/toolchain baseline and drops everything else", () => {
    const env = allowlistedBaseEnv(RUNNER_ENV);

    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.HOME, "/home/runner");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp.pem");
    assert.equal(env.XDG_CONFIG_HOME, "/home/runner/.config");

    for (const key of SENSITIVE_KEYS) {
      assert.equal(env[key], undefined, `${key} must not leak into the child`);
    }
  });

  it("never emits an unset allowlisted var as a string", () => {
    const env = allowlistedBaseEnv({ PATH: "/usr/bin" });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal("HOME" in env, false);
  });

  it("supports a caller-supplied allowlist without mutating the default", () => {
    const env = allowlistedBaseEnv({ FOO: "bar", PATH: "/usr/bin" }, new Set(["FOO"]));
    assert.equal(env.FOO, "bar");
    assert.equal(env.PATH, undefined);
    assert.equal(CHILD_ENV_ALLOWLIST.has("FOO"), false);
  });

  it("supervisorChildEnv passes required env and leaks no runner secret", () => {
    const env = supervisorChildEnv({
      baseEnv: RUNNER_ENV,
      token: "hub-token",
      baseUrl: "http://hub",
      claudeOauthToken: "local-oauth",
      secretEnv: { API_KEY: "per-run-secret" },
      runEnv: { RUNYARD_RUN_ID: "run_42" }
    });

    // Required baseline + explicit channels reach the child.
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.HOME, "/home/runner");
    assert.equal(env.RUN_SMITHERS_HUB_TOKEN, "hub-token");
    assert.equal(env.RUN_SMITHERS_HUB_URL, "http://hub");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "local-oauth");
    assert.equal(env.API_KEY, "per-run-secret");
    assert.equal(env.RUNYARD_RUN_ID, "run_42");

    // No runner/hub secret survives the launch env.
    for (const key of SENSITIVE_KEYS) {
      assert.equal(env[key], undefined, `${key} must not leak into the launch env`);
    }
  });
});
