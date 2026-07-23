import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createScmStore } from "../src/scmStore.js";
import { normalizeTrustPolicy, validateTrustPolicyBody } from "../src/scmRecords.js";

// SCM connection store: installations, repos, and the webhook delivery
// ledger. Real in-memory SQLite so unique constraints, JSON columns, and the
// pruning DELETE are exercised for real.
function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const deps = {
    all,
    one,
    run,
    id: (prefix) => `${prefix}_${++counter}`,
    now: () => new Date(1750000000000 + ++counter * 1000).toISOString()
  };
  return { db, scm: createScmStore(deps) };
}

describe("trust policy normalization", () => {
  it("defaults to untrusted with native execution off", () => {
    assert.deepEqual(normalizeTrustPolicy(undefined), { level: "untrusted", allowNative: false, runnerTags: [] });
  });

  it("never allows native execution for an untrusted repo, even when asked", () => {
    const policy = normalizeTrustPolicy({ level: "untrusted", allowNative: true });
    assert.equal(policy.allowNative, false);
  });

  it("allows native only for trusted level and dedupes runner tags", () => {
    const policy = normalizeTrustPolicy({ level: "trusted", allowNative: true, runnerTags: ["ci", "ci", " fast "] });
    assert.deepEqual(policy, { level: "trusted", allowNative: true, runnerTags: ["ci", "fast"] });
  });

  it("rejects malformed trust policy bodies with a legible error", () => {
    assert.equal(validateTrustPolicyBody({ level: "root" }).ok, false);
    assert.equal(validateTrustPolicyBody({ allowNative: "yes" }).ok, false);
    assert.equal(validateTrustPolicyBody({ runnerTags: [""] }).ok, false);
    assert.equal(validateTrustPolicyBody({ level: "trusted", allowNative: true }).ok, true);
  });
});

describe("scm installations", () => {
  it("upserts installation identity idempotently and never stores tokens", () => {
    const { scm } = createHarness();
    const created = scm.upsertScmInstallation({ installationId: 12345, accountLogin: "yolo-maxi", accountType: "User", appId: 99 });
    assert.equal(created.installationId, "12345");
    assert.equal(created.status, "active");

    const updated = scm.upsertScmInstallation({ installationId: 12345, status: "suspended" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.status, "suspended");
    assert.equal(updated.accountLogin, "yolo-maxi");
    assert.equal(scm.listScmInstallations().length, 1);
    for (const key of Object.keys(updated)) {
      assert.doesNotMatch(key.toLowerCase(), /token|secret|key/, `installation exposes suspicious field: ${key}`);
    }
  });
});

describe("scm repos", () => {
  it("creates disabled by default; sync updates identity but never enablement or trust", () => {
    const { scm } = createHarness();
    const repo = scm.upsertScmRepo({
      externalId: 1,
      owner: "yolo-maxi",
      name: "runyard",
      fullName: "yolo-maxi/runyard",
      cloneUrl: "https://github.com/yolo-maxi/runyard.git",
      defaultBranch: "main",
      installationId: 12345
    });
    assert.equal(repo.enabled, false);
    assert.equal(repo.trustPolicy.level, "untrusted");

    const enabled = scm.setScmRepoEnabled(repo.id, true);
    assert.equal(enabled.enabled, true);
    const trusted = scm.setScmRepoTrustPolicy(repo.id, { level: "trusted", allowNative: true });
    assert.equal(trusted.trustPolicy.allowNative, true);

    // A later provider sync must not clobber the operator's decisions.
    const synced = scm.upsertScmRepo({ fullName: "yolo-maxi/runyard", defaultBranch: "trunk" });
    assert.equal(synced.defaultBranch, "trunk");
    assert.equal(synced.enabled, true);
    assert.equal(synced.trustPolicy.level, "trusted");
  });

  it("looks up by id or full name and filters enabled repos", () => {
    const { scm } = createHarness();
    const a = scm.upsertScmRepo({ owner: "o", name: "a", fullName: "o/a" });
    scm.upsertScmRepo({ owner: "o", name: "b", fullName: "o/b" });
    scm.setScmRepoEnabled(a.id, true);
    assert.equal(scm.getScmRepo("o/a").id, a.id);
    assert.equal(scm.getScmRepo(a.id).fullName, "o/a");
    assert.equal(scm.listScmRepos().length, 2);
    assert.deepEqual(scm.listScmRepos({ enabledOnly: true }).map((r) => r.fullName), ["o/a"]);
  });
});

describe("scm webhook deliveries", () => {
  it("records, finds by delivery id, and enforces unique delivery ids", () => {
    const { scm } = createHarness();
    scm.recordScmWebhookDelivery({ deliveryId: "d-1", event: "push", payloadHash: "abc", status: "accepted" });
    const found = scm.findScmWebhookDelivery("d-1");
    assert.equal(found.event, "push");
    assert.equal(found.payloadHash, "abc");
    assert.throws(() => scm.recordScmWebhookDelivery({ deliveryId: "d-1", event: "push" }), /UNIQUE/i);
  });

  it("counts by status/window and prunes old rows (bounded retention)", () => {
    const { scm } = createHarness();
    scm.recordScmWebhookDelivery({ deliveryId: "d-1", event: "push", status: "accepted" });
    scm.recordScmWebhookDelivery({ deliveryId: "d-2", event: "push", status: "ignored" });
    scm.recordScmWebhookDelivery({ deliveryId: "d-3", event: "pull_request", status: "duplicate" });
    assert.equal(scm.countScmWebhookDeliveries(), 3);
    assert.equal(scm.countScmWebhookDeliveries({ status: "duplicate" }), 1);
    assert.equal(scm.listScmWebhookDeliveries({ status: "ignored" }).length, 1);

    const pruned = scm.pruneScmWebhookDeliveries(new Date(1750000000000 + 10_000_000).toISOString());
    assert.equal(pruned, 3);
    assert.equal(scm.countScmWebhookDeliveries(), 0);
  });
});
