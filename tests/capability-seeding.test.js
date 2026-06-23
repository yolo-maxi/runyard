import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-seed-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_seed_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { seedCapabilities } = await import("../src/seeds.js");
const { db, getCapability, upsertCapability } = await import("../src/db.js");

function seed(slug) {
  return seedCapabilities.find((capability) => capability.slug === slug);
}

function snapshotCount(capabilityId) {
  return db.prepare("SELECT COUNT(*) AS count FROM capability_versions WHERE capability_id = ?").get(capabilityId).count;
}

describe("capability seed idempotency", () => {
  it("does not bump version or snapshot when a seed definition is unchanged", () => {
    const before = getCapability("hello");
    const beforeSnapshots = snapshotCount(before.id);

    const after = upsertCapability(seed("hello"));

    assert.equal(after.version, before.version);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.definitionHash, before.definitionHash);
    assert.ok(after.definitionHash);
    assert.equal(snapshotCount(before.id), beforeSnapshots);
  });

  it("treats equivalent nested object key order as the same content", () => {
    const hello = seed("hello");
    const before = getCapability("hello");

    const after = upsertCapability({
      ...hello,
      inputSchema: {
        properties: hello.inputSchema.properties,
        required: hello.inputSchema.required,
        type: hello.inputSchema.type
      }
    });

    assert.equal(after.version, before.version);
    assert.equal(after.definitionHash, before.definitionHash);
  });

  it("bumps version and snapshots when seed content changes", () => {
    const hello = seed("hello");
    const before = getCapability("hello");
    const beforeSnapshots = snapshotCount(before.id);

    const changed = upsertCapability({
      ...hello,
      description: `${hello.description} Changed for test.`
    });

    assert.equal(changed.version, before.version + 1);
    assert.notEqual(changed.definitionHash, before.definitionHash);
    assert.equal(snapshotCount(before.id), beforeSnapshots + 1);
  });
});
