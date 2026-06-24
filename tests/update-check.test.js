import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseSemver, compareSemver, isNewerVersion, createUpdateChecker, tagFromRelease } = await import(
  "../src/updateCheck.js"
);

describe("semver compare", () => {
  it("parses with and without a leading v, and rejects garbage", () => {
    assert.deepEqual(
      { ...parseSemver("v1.2.3") },
      { major: 1, minor: 2, patch: 3, prerelease: "", raw: "1.2.3" }
    );
    assert.equal(parseSemver("1.2.3").major, 1);
    assert.equal(parseSemver("banana"), null);
    assert.equal(parseSemver("1.2"), null);
    assert.equal(parseSemver(""), null);
    assert.equal(parseSemver(null), null);
  });

  it("orders equal / newer / older correctly", () => {
    assert.equal(compareSemver("1.2.3", "1.2.3"), 0); // equal
    assert.equal(compareSemver("1.3.0", "1.2.9"), 1); // newer minor
    assert.equal(compareSemver("2.0.0", "1.9.9"), 1); // newer major
    assert.equal(compareSemver("1.2.4", "1.2.3"), 1); // newer patch
    assert.equal(compareSemver("1.2.0", "1.3.0"), -1); // older
    assert.equal(compareSemver("v1.2.3", "1.2.3"), 0); // v-prefix ignored
  });

  it("treats a prerelease as lower precedence than its release", () => {
    assert.equal(compareSemver("1.2.3-rc.1", "1.2.3"), -1);
    assert.equal(compareSemver("1.2.3", "1.2.3-rc.1"), 1);
    assert.equal(compareSemver("1.2.3-rc.2", "1.2.3-rc.1"), 1);
    assert.equal(compareSemver("1.2.3-alpha", "1.2.3-beta"), -1);
  });

  it("returns null when either side is malformed", () => {
    assert.equal(compareSemver("banana", "1.2.3"), null);
    assert.equal(compareSemver("1.2.3", "nope"), null);
  });

  it("isNewerVersion fails safe on malformed input (no spurious update)", () => {
    assert.equal(isNewerVersion("1.3.0", "1.2.0"), true);
    assert.equal(isNewerVersion("1.2.0", "1.2.0"), false); // equal is not newer
    assert.equal(isNewerVersion("1.1.0", "1.2.0"), false); // older
    assert.equal(isNewerVersion("garbage", "1.2.0"), false); // malformed latest
    assert.equal(isNewerVersion("1.3.0", "garbage"), false); // malformed current
  });

  it("extracts a tag from a release object", () => {
    assert.equal(tagFromRelease({ tag_name: "v1.4.0" }), "v1.4.0");
    assert.equal(tagFromRelease({ name: "1.4.0" }), "1.4.0");
    assert.equal(tagFromRelease(null), "");
  });
});

// A counting fetch stub: returns canned responses, records call count, and
// (critically) makes NO real network request — the suite never hits GitHub.
function stubFetch(responder) {
  let calls = 0;
  const fn = async (url, options) => {
    calls += 1;
    return responder(url, options, calls);
  };
  return {
    fn,
    get calls() {
      return calls;
    }
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

describe("update checker (mocked, no live network)", () => {
  it("reports updateAvailable when the latest release is newer", async () => {
    const fetch = stubFetch(() => jsonResponse({ tag_name: "v1.5.0" }));
    const checker = createUpdateChecker({
      repo: "owner/repo",
      currentVersion: "1.4.0",
      fetchImpl: fetch.fn,
      now: () => 1000
    });
    const result = await checker.check();
    assert.equal(result.status, "ok");
    assert.equal(result.latest, "1.5.0");
    assert.equal(result.updateAvailable, true);
    assert.equal(fetch.calls, 1);
  });

  it("reports no update when already on the latest", async () => {
    const fetch = stubFetch(() => jsonResponse({ tag_name: "v1.4.0" }));
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.4.0", fetchImpl: fetch.fn, now: () => 1 });
    const result = await checker.check();
    assert.equal(result.updateAvailable, false);
    assert.equal(result.status, "ok");
  });

  it("caches within the ttl and refreshes after it (no API hammering)", async () => {
    let t = 0;
    const fetch = stubFetch(() => jsonResponse({ tag_name: "v9.9.9" }));
    const checker = createUpdateChecker({
      repo: "o/r",
      currentVersion: "1.0.0",
      fetchImpl: fetch.fn,
      ttlMs: 1000,
      now: () => t
    });
    await checker.check(); // t=0 -> network
    await checker.check(); // cached
    assert.equal(fetch.calls, 1, "second call within ttl must not hit the network");
    t = 1500; // past ttl
    await checker.check();
    assert.equal(fetch.calls, 2, "a call past the ttl refreshes");
  });

  it("forces a refresh when force=true even within the ttl", async () => {
    const fetch = stubFetch(() => jsonResponse({ tag_name: "v2.0.0" }));
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    await checker.check();
    await checker.check(true);
    assert.equal(fetch.calls, 2);
  });

  it("degrades to 'unknown' on a network failure and never throws", async () => {
    const fetch = stubFetch(() => {
      throw new Error("ENOTFOUND api.github.com");
    });
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    const result = await checker.check();
    assert.equal(result.status, "unknown");
    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /ENOTFOUND/);
  });

  it("handles rate limiting (403) without treating it as an update", async () => {
    const fetch = stubFetch(() => jsonResponse({}, { ok: false, status: 403 }));
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    const result = await checker.check();
    assert.equal(result.status, "rate_limited");
    assert.equal(result.updateAvailable, false);
  });

  it("treats a non-OK response as 'unknown'", async () => {
    const fetch = stubFetch(() => jsonResponse({}, { ok: false, status: 500 }));
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    const result = await checker.check();
    assert.equal(result.status, "unknown");
  });

  it("treats an unparseable tag as 'unknown'", async () => {
    const fetch = stubFetch(() => jsonResponse({ tag_name: "nightly" }));
    const checker = createUpdateChecker({ repo: "o/r", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    const result = await checker.check();
    assert.equal(result.status, "unknown");
    assert.equal(result.updateAvailable, false);
  });

  it("is disabled (no network) when no repo is configured", async () => {
    const fetch = stubFetch(() => jsonResponse({ tag_name: "v2.0.0" }));
    const checker = createUpdateChecker({ repo: "", currentVersion: "1.0.0", fetchImpl: fetch.fn, now: () => 0 });
    const result = await checker.check();
    assert.equal(result.status, "disabled");
    assert.equal(fetch.calls, 0, "a missing repo must never make a network call");
  });
});
