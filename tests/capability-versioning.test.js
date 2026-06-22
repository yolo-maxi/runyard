// Acceptance check for capability version pinning + rollback.
// Behavior is gated behind RUNYARD_CAPABILITY_VERSIONING=1 so existing tests
// (and the legacy run path) remain byte-for-byte unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-capver-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_capver_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";
// Enable the feature flag BEFORE importing the server / db modules so the
// runExecution helpers read it as enabled for this whole file.
process.env.RUNYARD_CAPABILITY_VERSIONING = "1";

const { app } = await import("../src/server.js");
const {
  capabilityVersioningEnabled,
  resolveCapabilityVersionOptions
} = await import("../src/runExecution.js");
const { resolveCapabilityRef, isGitSha } = await import("../src/repoCatalog.js");

let server;
let baseUrl;
const token = "shub_capver_token";

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.RUNYARD_CAPABILITY_VERSIONING;
});

describe("capability version pinning + rollback", () => {
  it("treats the flag as off by default and on only for '1'", () => {
    assert.equal(capabilityVersioningEnabled({}), false);
    assert.equal(capabilityVersioningEnabled({ RUNYARD_CAPABILITY_VERSIONING: "" }), false);
    assert.equal(capabilityVersioningEnabled({ RUNYARD_CAPABILITY_VERSIONING: "0" }), false);
    assert.equal(capabilityVersioningEnabled({ RUNYARD_CAPABILITY_VERSIONING: "true" }), false);
    assert.equal(capabilityVersioningEnabled({ RUNYARD_CAPABILITY_VERSIONING: "1" }), true);
  });

  it("drops capabilitySha / parentRunId when the flag is off, even if provided", () => {
    const off = resolveCapabilityVersionOptions(
      { capabilitySha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", parentRunId: "run_parent" },
      {}
    );
    assert.equal(off.capabilitySha, null);
    assert.equal(off.parentRunId, null);

    const on = resolveCapabilityVersionOptions(
      { capabilitySha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", parentRunId: "run_parent" },
      { RUNYARD_CAPABILITY_VERSIONING: "1" }
    );
    assert.equal(on.capabilitySha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.equal(on.parentRunId, "run_parent");
  });

  it("resolveCapabilityRef returns the original capability payload alongside the sha", () => {
    const capability = { slug: "hello", name: "Hello", version: 1 };
    const explicit = resolveCapabilityRef(capability, {
      pin: "abcdef1234567890abcdef1234567890abcdef12",
      env: { RUNYARD_CAPABILITY_VERSIONING: "1" }
    });
    assert.equal(explicit.capability, capability, "must not mutate or replace the capability payload");
    assert.equal(explicit.capabilitySha, "abcdef1234567890abcdef1234567890abcdef12");

    const offMissingPin = resolveCapabilityRef(capability, { env: {} });
    assert.equal(offMissingPin.capability, capability);
    assert.equal(offMissingPin.capabilitySha, null);

    // Bad pin shapes are rejected without throwing, so the runtime can never
    // accidentally feed a non-SHA into git or the runs table.
    assert.equal(isGitSha("not-a-sha"), false);
    assert.equal(isGitSha(""), false);
    assert.equal(isGitSha("abc1234"), true);
  });

  it("persists capability_sha + parent_run_id on POST /api/capabilities/:id/run with --pin", async () => {
    const pin = "1234567890abcdef1234567890abcdef12345678";
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "pinned" },
        pin,
        origin: { type: "api-test", label: "pin test" }
      }
    });
    assert.equal(created.run.capabilitySha, pin);
    assert.equal(created.run.parentRunId, null);

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.capabilitySha, pin);
    assert.equal(detail.run.parentRunId, null);
  });

  it("rollback creates a new run pinned to the prior sha with parent_run_id set", async () => {
    const originalPin = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const original = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { topic: "rollback-source" }, pin: originalPin }
    });
    assert.equal(original.run.capabilitySha, originalPin);

    const rollbackPin = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const rolled = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "rollback-target" },
        pin: rollbackPin,
        parentRunId: original.run.id,
        origin: { type: "api-test", label: "rollback" }
      }
    });
    assert.equal(rolled.run.capabilitySha, rollbackPin);
    assert.equal(rolled.run.parentRunId, original.run.id);

    const detail = await api(`/api/runs/${rolled.run.id}`);
    assert.equal(detail.run.parentRunId, original.run.id);
  });

  it("GET /api/capabilities/:name/versions returns distinct SHAs observed across runs", async () => {
    const data = await api("/api/capabilities/hello/versions");
    assert.equal(data.versioningEnabled, true);
    assert.equal(data.capability.slug, "hello");
    const shas = data.versions.map((v) => v.sha);
    assert.ok(shas.includes("1234567890abcdef1234567890abcdef12345678"));
    assert.ok(shas.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.ok(shas.includes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    // Distinct: every sha appears at most once in the list.
    assert.equal(new Set(shas).size, shas.length);
    // Each entry carries the aggregate counters the rollback UI needs.
    for (const entry of data.versions) {
      assert.equal(typeof entry.runCount, "number");
      assert.ok(entry.runCount >= 1);
      assert.ok(entry.firstSeenAt);
      assert.ok(entry.lastSeenAt);
    }
  });

  it("returns 404 for an unknown capability on the versions endpoint", async () => {
    await assert.rejects(() => api("/api/capabilities/no-such-capability/versions"));
  });
});
