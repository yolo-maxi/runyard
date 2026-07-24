import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";

import { createCiHarness, SAMPLE_CI_YML } from "./ci-harness.js";
import { createGithubWebhookHandlers, payloadHash } from "../src/githubWebhooks.js";
import { mockResponse } from "./response.js";

const SECRET = "hooksecret";
const CONFIG_KEY = `yolo-maxi/runyard@${"a".repeat(40)}`;

function buildHandlers(h, overrides = {}) {
  const env = { ...h.env, githubWebhookSecret: SECRET, githubAppId: "1234" };
  return createGithubWebhookHandlers({
    env,
    githubApp: h.githubApp,
    ciTriggers: h.ciTriggers,
    advancePipeline: h.orchestrator.advancePipeline,
    syncChecksSoon: () => {},
    findScmWebhookDelivery: h.scm.findScmWebhookDelivery,
    recordScmWebhookDelivery: h.scm.recordScmWebhookDelivery,
    updateScmWebhookDelivery: h.scm.updateScmWebhookDelivery,
    deleteScmWebhookDelivery: h.scm.deleteScmWebhookDelivery,
    upsertScmInstallation: h.scm.upsertScmInstallation,
    upsertScmRepo: h.scm.upsertScmRepo,
    getScmRepo: h.scm.getScmRepo,
    setScmRepoEnabled: h.scm.setScmRepoEnabled,
    recordAudit: (actor, action, target, detail) => h.audits.push({ actor, action, target, detail }),
    logError: () => {},
    ...overrides
  });
}

function signedRequest(payload, { event = "push", deliveryId = "gh-1", secret = SECRET, tamper = false } = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return {
    headers: {
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature
    },
    body: tamper ? Buffer.concat([rawBody, Buffer.from(" ")]) : rawBody
  };
}

function pushPayload(overrides = {}) {
  return {
    ref: "refs/heads/main",
    before: "9".repeat(40),
    after: "a".repeat(40),
    deleted: false,
    repository: { full_name: "yolo-maxi/runyard" },
    sender: { login: "ocean" },
    commits: [{ added: ["src/db.js"], modified: [], removed: [] }],
    ...overrides
  };
}

describe("github webhook ingress", () => {
  it("verifies the signature before anything else", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo();
    const handlers = buildHandlers(h);

    const bad = signedRequest(pushPayload(), { secret: "wrong" });
    const res = mockResponse();
    await handlers.githubWebhook(bad, res);
    assert.equal(res.statusCode, 401);
    assert.equal(handlers.counters.signatureFailures, 1);
    assert.ok(h.audits.some((a) => a.action === "ci.webhook.signature_failed"));

    const tampered = signedRequest(pushPayload(), { tamper: true });
    const res2 = mockResponse();
    await handlers.githubWebhook(tampered, res2);
    assert.equal(res2.statusCode, 401);
    assert.equal(h.scm.countScmWebhookDeliveries(), 0, "nothing recorded for unverified requests");
  });

  it("accepts a signed push, creates a pipeline, and records the delivery", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const handlers = buildHandlers(h);
    const res = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "accepted");
    assert.ok(res.body.pipelineId);
    const delivery = h.scm.findScmWebhookDelivery("gh-1");
    assert.equal(delivery.status, "accepted");
    assert.equal(delivery.pipelineId, res.body.pipelineId);
    // The post-accept nudge dispatched the first job.
    assert.equal(h.ci.listCiJobs(res.body.pipelineId).some((j) => j.phase === "dispatched"), true);
  });

  it("is replay-safe: same delivery acks as duplicate, altered payload conflicts", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo();
    const handlers = buildHandlers(h);
    await handlers.githubWebhook(signedRequest(pushPayload()), mockResponse());

    const replay = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), replay);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.status, "duplicate");
    assert.equal(handlers.counters.duplicates, 1);
    assert.equal(h.listRuns({ includeInternal: true, limit: 100 }).filter((r) => r.capabilitySlug === "ci-pipeline").length, 1);

    const conflicting = mockResponse();
    await handlers.githubWebhook(
      signedRequest(pushPayload({ after: "f".repeat(40) }), { deliveryId: "gh-1" }),
      conflicting
    );
    assert.equal(conflicting.statusCode, 409);
    assert.equal(handlers.counters.conflicts, 1);
  });

  it("acknowledges unsupported events and unsupported PR actions as ignored", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo();
    const handlers = buildHandlers(h);
    const star = mockResponse();
    await handlers.githubWebhook(signedRequest({ action: "created" }, { event: "star", deliveryId: "gh-star" }), star);
    assert.equal(star.body.status, "ignored");
    const labeled = mockResponse();
    await handlers.githubWebhook(
      signedRequest({ action: "labeled", repository: { full_name: "yolo-maxi/runyard" } }, { event: "pull_request", deliveryId: "gh-pr" }),
      labeled
    );
    assert.equal(labeled.body.status, "ignored");
    assert.equal(h.scm.findScmWebhookDelivery("gh-star").status, "ignored");
  });

  it("syncs installations and repositories from installation events", async () => {
    const h = createCiHarness({ githubFiles: {} });
    const handlers = buildHandlers(h);
    const res = mockResponse();
    await handlers.githubWebhook(
      signedRequest(
        {
          action: "created",
          installation: { id: 42, account: { login: "yolo-maxi", type: "User" }, app_id: 1234 },
          repositories: [{ id: 1, full_name: "yolo-maxi/runyard", private: false }]
        },
        { event: "installation", deliveryId: "gh-inst" }
      ),
      res
    );
    assert.equal(res.body.status, "accepted");
    assert.equal(h.scm.getScmInstallation(42).accountLogin, "yolo-maxi");
    const repo = h.scm.getScmRepo("yolo-maxi/runyard");
    assert.equal(repo.installationId, "42");
    assert.equal(repo.enabled, false, "sync never auto-enables CI");

    // Removal disables CI for the repo but preserves the row.
    h.scm.setScmRepoEnabled(repo.id, true);
    await handlers.githubWebhook(
      signedRequest(
        {
          action: "removed",
          installation: { id: 42, account: { login: "yolo-maxi" } },
          repositories_removed: [{ full_name: "yolo-maxi/runyard" }]
        },
        { event: "installation_repositories", deliveryId: "gh-instr" }
      ),
      mockResponse()
    );
    const after = h.scm.getScmRepo("yolo-maxi/runyard");
    assert.equal(after.enabled, false);
    assert.equal(after.installationId, "");
  });

  it("handler failures answer 500 and stay OUT of the dedupe ledger so redelivery reprocesses", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo();
    let failures = 1;
    const failingTriggers = {
      ...h.ciTriggers,
      createPipelineForTrigger: async (trigger) => {
        if (failures-- > 0) throw new Error("transient db lock");
        return h.ciTriggers.createPipelineForTrigger(trigger);
      }
    };
    const handlers = buildHandlers(h, { ciTriggers: failingTriggers });
    const res = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), res);
    assert.equal(res.statusCode, 500);
    assert.equal(h.scm.findScmWebhookDelivery("gh-1"), null);
    assert.ok(h.audits.some((a) => a.action === "ci.webhook.error"));

    // GitHub redelivers the same delivery id -> processed for real this time.
    const retry = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.status, "accepted");
  });

  it("rerequested check_run events owned by this app rerun the pipeline", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const handlers = buildHandlers(h);
    const first = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), first);
    const job = h.ci.listCiJobs(first.body.pipelineId)[0];

    const rerequest = mockResponse();
    await handlers.githubWebhook(
      signedRequest(
        { action: "rerequested", check_run: { external_id: job.id, app: { id: 1234 } }, sender: { login: "ocean" }, repository: { full_name: "yolo-maxi/runyard" } },
        { event: "check_run", deliveryId: "gh-rr" }
      ),
      rerequest
    );
    assert.equal(rerequest.body.status, "accepted");
    assert.notEqual(rerequest.body.pipelineId, first.body.pipelineId);

    const foreign = mockResponse();
    await handlers.githubWebhook(
      signedRequest(
        { action: "rerequested", check_run: { external_id: "x", app: { id: 999 } }, repository: { full_name: "yolo-maxi/runyard" } },
        { event: "check_run", deliveryId: "gh-rr2" }
      ),
      foreign
    );
    assert.equal(foreign.body.status, "ignored");
  });

  it("rejects unconfigured hubs and empty bodies without touching state", async () => {
    const h = createCiHarness({ githubFiles: {} });
    const handlers = buildHandlers(h, { githubApp: { ...h.githubApp, configured: () => false } });
    const res = mockResponse();
    await handlers.githubWebhook(signedRequest(pushPayload()), res);
    assert.equal(res.statusCode, 503);

    const configured = buildHandlers(h);
    const empty = mockResponse();
    await configured.githubWebhook({ headers: {}, body: Buffer.alloc(0) }, empty);
    assert.equal(empty.statusCode, 400);
  });

  it("payload hashes are stable sha256 over raw bytes", () => {
    const raw = Buffer.from('{"a":1}');
    assert.equal(payloadHash(raw), payloadHash(Buffer.from('{"a":1}')));
    assert.notEqual(payloadHash(raw), payloadHash(Buffer.from('{"a":2}')));
  });
});

describe("review regressions (webhook)", () => {
  it("two concurrent identical deliveries create exactly one pipeline (reservation beats TOCTOU)", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: SAMPLE_CI_YML } });
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const slowTriggers = {
      ...h.ciTriggers,
      async createPipelineForTrigger(trigger) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return h.ciTriggers.createPipelineForTrigger(trigger);
      }
    };
    const handlers = buildHandlers(h, { ciTriggers: slowTriggers });
    const res1 = mockResponse();
    const res2 = mockResponse();
    await Promise.all([
      handlers.githubWebhook(signedRequest(pushPayload()), res1),
      handlers.githubWebhook(signedRequest(pushPayload()), res2)
    ]);
    const statuses = [res1.body.status, res2.body.status].sort();
    assert.deepEqual(statuses, ["accepted", "duplicate"]);
    const pipelines = h.listRuns({ includeInternal: true, limit: 100 }).filter((r) => r.capabilitySlug === "ci-pipeline");
    assert.equal(pipelines.length, 1, "exactly one pipeline despite the concurrent replay");
  });
});
