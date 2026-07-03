import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { supportWarmEnabled } = await import("../src/supportWarm.js");

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
