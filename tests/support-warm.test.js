import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { supportWarmChildEnv, supportWarmEnabled } = await import("../src/supportWarm.js");

describe("supportWarmEnabled gating", () => {
  // The gate shares parseBool with every other opt-in flag (env.js, reauthCli):
  // off unless set, truthy for anything but the falsy words. This test pins that
  // contract so the special-path branch in runnerSpecialRuns.js can't silently
  // start (or stop) matching on the general runner pool.
  it("is off by default, on for truthy values, off for falsy words", () => {
    const prev = process.env.SUPPORT_WARM;
    try {
      delete process.env.SUPPORT_WARM;
      assert.equal(supportWarmEnabled(), false);
      for (const on of ["1", "true", "yes"]) {
        process.env.SUPPORT_WARM = on;
        assert.equal(supportWarmEnabled(), true, `expected SUPPORT_WARM=${on} to enable`);
      }
      for (const off of ["0", "false", "off", "no", ""]) {
        process.env.SUPPORT_WARM = off;
        assert.equal(supportWarmEnabled(), false, `expected SUPPORT_WARM=${JSON.stringify(off)} to disable`);
      }
    } finally {
      if (prev === undefined) delete process.env.SUPPORT_WARM;
      else process.env.SUPPORT_WARM = prev;
    }
  });
});

describe("supportWarmChildEnv", () => {
  // What the dedicated support-runner actually carries: OS baseline the claude
  // CLI needs, plus the runner's own tokens that must NEVER reach the child.
  const RUNNER_ENV = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/support-runner",
    LANG: "en_US.UTF-8",
    RUNYARD_READ_TOKEN: "read-token-must-not-leak",
    SECRETS_ENC_KEY: "master-key-must-not-leak",
    RUNYARD_HUB_BOOTSTRAP_TOKEN: "bootstrap-must-not-leak",
    OPENAI_API_KEY: "sk-must-not-leak",
    SUPPORT_WARM: "1"
  };

  it("passes only the OS baseline plus the Claude OAuth token, no runner secrets", () => {
    const env = supportWarmChildEnv({
      baseEnv: { ...RUNNER_ENV, CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth" },
      readToken: () => "file-oauth"
    });

    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.HOME, "/home/support-runner");
    // Ambient token wins over the runner-local token file (pre-existing precedence).
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "ambient-oauth");

    for (const key of ["RUNYARD_READ_TOKEN", "SECRETS_ENC_KEY", "RUNYARD_HUB_BOOTSTRAP_TOKEN", "OPENAI_API_KEY", "SUPPORT_WARM"]) {
      assert.equal(env[key], undefined, `${key} must not leak into the claude child`);
    }
  });

  it("falls back to the runner-local token file when no ambient token is set", () => {
    const env = supportWarmChildEnv({ baseEnv: RUNNER_ENV, readToken: () => "file-oauth" });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "file-oauth");
  });

  it("omits CLAUDE_CODE_OAUTH_TOKEN entirely when neither source has one", () => {
    const env = supportWarmChildEnv({ baseEnv: RUNNER_ENV, readToken: () => "" });
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
  });
});
