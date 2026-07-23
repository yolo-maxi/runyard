import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Deterministic end-to-end CI loop against the REAL hub process surface:
//   signed GitHub webhook -> verified + deduplicated delivery -> pipeline
//   (parent run) -> claimed ci-job runs via the exact runner-protocol HTTP
//   calls src/runner.js makes -> artifact/log evidence -> GitHub Check
//   updates against a local fake GitHub server. No network, no live GitHub.

const WEBHOOK_SECRET = "e2e-hook-secret";
const HEAD_SHA = "a".repeat(40);
const CI_YML = `
version: 1
name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    executor: native
    commands: ["echo build"]
  test:
    executor: native
    needs: [build]
    commands: ["echo test"]
`;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

let fakeGithub;
let githubCalls;
let hubServer;
let hubUrl;
let api;
let dataDir;
let serverModule;
let db;

function startFakeGithub() {
  githubCalls = [];
  let checkId = 7000;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const call = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization || "" };
      githubCalls.push(call);
      const respond = (code, payload) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) {
        return respond(201, { token: "ghs_e2e_token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (req.method === "GET" && req.url.startsWith("/repos/yolo-maxi/e2e-repo/contents/.runyard%2Fci.yml")) {
        return respond(200, { content: Buffer.from(CI_YML).toString("base64"), size: CI_YML.length });
      }
      if (req.method === "GET" && req.url.startsWith("/repos/yolo-maxi/e2e-repo/contents/.runyard/ci.yml")) {
        return respond(200, { content: Buffer.from(CI_YML).toString("base64"), size: CI_YML.length });
      }
      if (req.method === "POST" && req.url === "/repos/yolo-maxi/e2e-repo/check-runs") {
        return respond(201, { id: ++checkId });
      }
      if (req.method === "PATCH" && /^\/repos\/yolo-maxi\/e2e-repo\/check-runs\/\d+$/.test(req.url)) {
        return respond(200, { id: Number(req.url.split("/").pop()) });
      }
      respond(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function signedWebhook(event, deliveryId, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return fetch(`${hubUrl}/api/ci/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`
    },
    body: raw
  });
}

before(async () => {
  fakeGithub = await startFakeGithub();
  const githubPort = fakeGithub.address().port;
  dataDir = mkdtempSync(path.join(os.tmpdir(), "runyard-ci-e2e-"));

  process.env.SMITHERS_HUB_ROOT = process.cwd();
  process.env.SMITHERS_HUB_DATA_DIR = dataDir;
  process.env.SMITHERS_HUB_DB = path.join(dataDir, "test.sqlite");
  process.env.SMITHERS_HUB_SESSION_SECRET = "e2e-session-secret";
  process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_e2e_admin_token_0123456789";
  process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";
  process.env.RUNYARD_GITHUB_APP_ID = "777";
  process.env.RUNYARD_GITHUB_APP_PRIVATE_KEY = privatePem;
  process.env.RUNYARD_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RUNYARD_GITHUB_API_BASE = `http://127.0.0.1:${githubPort}`;

  serverModule = await import("../src/server.js");
  db = await import("../src/db.js");
  await new Promise((resolve) => {
    hubServer = serverModule.app.listen(0, "127.0.0.1", resolve);
  });
  hubUrl = `http://127.0.0.1:${hubServer.address().port}`;
  api = async (method, pathname, body) => {
    const response = await fetch(`${hubUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  };
});

after(() => {
  hubServer?.close();
  fakeGithub?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CI end-to-end (fake GitHub)", () => {
  let pipelineId;
  let parentRunId;
  let runnerId;
  const claimedRuns = [];

  async function claimNextRun() {
    const claim = await api("GET", `/api/runners/${runnerId}/next-run`);
    assert.equal(claim.status, 200);
    return claim.data;
  }

  it("syncs the installation + repo from a signed installation webhook", async () => {
    const response = await signedWebhook("installation", "e2e-inst-1", {
      action: "created",
      installation: { id: 4242, account: { login: "yolo-maxi", type: "User" }, app_id: 777 },
      repositories: [{ id: 9, full_name: "yolo-maxi/e2e-repo", private: true }]
    });
    assert.equal(response.status, 200);
    const repos = await api("GET", "/api/ci/repos");
    assert.equal(repos.status, 200);
    const repo = repos.data.repos.find((r) => r.fullName === "yolo-maxi/e2e-repo");
    assert.ok(repo, "repo connected from installation event");
    assert.equal(repo.enabled, false, "never auto-enabled");
    assert.equal(repos.data.installations[0].installationId, "4242");

    // Operator enables CI + grants trust over the authenticated API.
    const enabled = await api("POST", `/api/ci/repos/${repo.id}/enable`);
    assert.equal(enabled.status, 200);
    const trusted = await api("PATCH", `/api/ci/repos/${repo.id}/trust`, { level: "trusted", allowNative: true });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.data.repo.trustPolicy.allowNative, true);
  });

  it("rejects a bad signature and never records unverified deliveries", async () => {
    const raw = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
    const response = await fetch(`${hubUrl}/api/ci/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "e2e-forged",
        "x-hub-signature-256": "sha256=" + "0".repeat(64)
      },
      body: raw
    });
    assert.equal(response.status, 401);
    const deliveries = await api("GET", "/api/ci/deliveries");
    assert.ok(!deliveries.data.deliveries.some((d) => d.deliveryId === "e2e-forged"));
  });

  it("a signed push creates a pipeline with trusted config provenance and dedupes replays", async () => {
    const payload = {
      ref: "refs/heads/main",
      before: "9".repeat(40),
      after: HEAD_SHA,
      deleted: false,
      repository: { full_name: "yolo-maxi/e2e-repo" },
      sender: { login: "ocean" },
      commits: [{ added: ["src/x.js"], modified: [], removed: [] }]
    };
    const response = await signedWebhook("push", "e2e-push-1", payload);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "accepted");
    pipelineId = body.pipelineId;
    parentRunId = body.runId;

    const replay = await signedWebhook("push", "e2e-push-1", payload);
    assert.equal((await replay.json()).status, "duplicate");

    const pipeline = await api("GET", `/api/ci/pipelines/${pipelineId}`);
    assert.equal(pipeline.status, 200);
    assert.equal(pipeline.data.pipeline.configSource.sha, HEAD_SHA, "config pinned to the pushed sha");
    assert.equal(pipeline.data.pipeline.tested.strategy, "head");
    assert.equal(pipeline.data.pipeline.run.status, "running");
    const jobs = pipeline.data.pipeline.jobs;
    assert.deepEqual(jobs.map((j) => j.jobName), ["build", "test"]);
    assert.equal(jobs[0].phase, "dispatched", "ready job dispatched by the post-webhook advance");
    assert.equal(jobs[1].phase, "pending", "needs-gated job waits");
  });

  it("a CI runner claims and executes jobs through the exact runner protocol", async () => {
    const registration = await api("POST", "/api/runners/register", {
      name: "e2e-ci-runner",
      hostname: "e2e-host",
      platform: "test",
      version: "0.0.0",
      tags: ["smithers", "vps", "ci"],
      capacity: 2
    });
    assert.equal(registration.status, 200);
    runnerId = registration.data.runner.id;
    await api("POST", `/api/runners/${runnerId}/heartbeat`, { tags: ["smithers", "vps", "ci"], capacity: 2, activeRuns: 0 });

    // Claim job 1 (build).
    const assignment = await claimNextRun();
    assert.ok(assignment?.run, "ci-job run claimable by a ci-tagged runner");
    assert.equal(assignment.capability.slug, "ci-job");
    assert.equal(assignment.run.input.__ci.jobName, "build");
    claimedRuns.push(assignment.run.id);

    await api("POST", `/api/runs/${assignment.run.id}/start`, {});
    // JIT git credential (runner protocol; token comes from fake GitHub).
    const credential = await api("POST", `/api/ci/runs/${assignment.run.id}/git-credential`, {});
    assert.equal(credential.status, 200);
    assert.equal(credential.data.token, "ghs_e2e_token");
    await api("POST", `/api/runs/${assignment.run.id}/events`, { type: "ci.job.log", message: "build output line" });
    await api("POST", `/api/runs/${assignment.run.id}/artifacts`, {
      name: "ci-job-log.txt",
      kind: "log",
      mimeType: "text/plain",
      content: "build output line\n"
    });
    const completed = await api("POST", `/api/runs/${assignment.run.id}/complete`, {
      output: { conclusion: "succeeded", exitCode: 0, tested: { strategy: "head", testedSha: HEAD_SHA } }
    });
    assert.equal(completed.status, 200);

    // The run-status observer advanced the DAG: job 2 is now claimable.
    const second = await claimNextRun();
    assert.ok(second?.run, "dependent job dispatched after its need succeeded");
    assert.equal(second.run.input.__ci.jobName, "test");
    claimedRuns.push(second.run.id);
    await api("POST", `/api/runs/${second.run.id}/start`, {});
    await api("POST", `/api/runs/${second.run.id}/complete`, {
      output: { conclusion: "succeeded", exitCode: 0, tested: { strategy: "head", testedSha: HEAD_SHA } }
    });

    const parent = await api("GET", `/api/runs/${parentRunId}`);
    assert.equal(parent.data.run.status, "succeeded", "pipeline parent reconciled from job outcomes");
    assert.equal(parent.data.run.output.conclusion, "succeeded");
  });

  it("reports GitHub checks for every job with deep links and correct conclusions", async () => {
    await serverModule.ciMaintenanceTick();
    // sync() is async inside the tick; give the event loop a beat.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const checkCreates = githubCalls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
    assert.ok(checkCreates.length >= 2, `expected job checks, saw ${checkCreates.length}`);
    const names = checkCreates.map((c) => c.body.name).sort();
    assert.deepEqual([...new Set(names)], ["runyard/build", "runyard/test"]);
    for (const call of checkCreates) {
      assert.equal(call.body.head_sha, HEAD_SHA);
      assert.match(call.body.details_url, /\/app#runs\/run_/);
      assert.ok(call.body.external_id.startsWith("cijob_"));
      assert.equal(call.auth, "Bearer ghs_e2e_token");
    }
    const terminalStates = githubCalls.filter((c) => (c.method === "POST" || c.method === "PATCH") && c.url.includes("/check-runs") && c.body.status === "completed");
    assert.ok(terminalStates.length >= 2);
    assert.ok(terminalStates.every((c) => c.body.conclusion === "success"));

    const pipeline = await api("GET", `/api/ci/pipelines/${pipelineId}`);
    for (const job of pipeline.data.pipeline.jobs) {
      assert.equal(job.checkState, "completed:success");
      assert.ok(job.checkRunId);
    }
  });

  it("keeps run evidence: events, artifacts, and provenance survive on the canonical runs", async () => {
    const detail = await api("GET", `/api/runs/${claimedRuns[0]}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.data.artifacts.some((a) => a.name === "ci-job-log.txt"));
    assert.ok(detail.data.events.some((e) => e.type === "ci.job.log"));
    assert.ok(detail.data.events.some((e) => e.type === "ci.git_credential.minted"));
    assert.equal(detail.data.run.input.__ci.repo.fullName, "yolo-maxi/e2e-repo");
  });

  it("cancel-supersedes an in-flight pipeline when a newer push arrives on the same branch", async () => {
    const newHead = "b".repeat(40);
    const payload = {
      ref: "refs/heads/main",
      before: HEAD_SHA,
      after: newHead,
      deleted: false,
      repository: { full_name: "yolo-maxi/e2e-repo" },
      sender: { login: "ocean" },
      commits: [{ added: [], modified: ["src/x.js"], removed: [] }]
    };
    const first = await (await signedWebhook("push", "e2e-push-2", payload)).json();
    assert.equal(first.status, "accepted");
    const superseding = await (
      await signedWebhook("push", "e2e-push-3", { ...payload, before: newHead, after: "c".repeat(40) })
    ).json();
    assert.equal(superseding.status, "accepted");

    const oldPipeline = await api("GET", `/api/ci/pipelines/${first.pipelineId}`);
    assert.equal(oldPipeline.data.pipeline.supersededBy, superseding.pipelineId);
    assert.equal(oldPipeline.data.pipeline.run.status, "cancelled");

    // Clean up: cancel the superseding pipeline so nothing stays active.
    const cancel = await api("POST", `/api/ci/pipelines/${superseding.pipelineId}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.pipeline.run.status, "cancelled");
  });

  it("exposes operator diagnostics with the delivery ledger and counters", async () => {
    const diagnostics = await api("GET", "/api/ci/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.data.githubApp.configured, true);
    assert.ok(diagnostics.data.webhooks.sinceBoot.accepted >= 3);
    assert.equal(diagnostics.data.webhooks.sinceBoot.signatureFailures, 1);
    assert.ok(diagnostics.data.webhooks.sinceBoot.duplicates >= 1);

    const deliveries = await api("GET", "/api/ci/deliveries");
    const push1 = deliveries.data.deliveries.find((d) => d.deliveryId === "e2e-push-1");
    assert.equal(push1.status, "accepted");
    assert.equal(push1.pipelineId, pipelineId);

    // Scope enforcement: a read-only token can see repos but not dispatch.
    const readToken = await api("POST", "/api/tokens", { name: "e2e-read", scopes: ["read"] });
    assert.equal(readToken.status, 200, JSON.stringify(readToken.data));
    const readApi = async (method, pathname, body) => {
      const response = await fetch(`${hubUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${readToken.data.token.token || readToken.data.token.value || readToken.data.secret}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    const readList = await readApi("GET", "/api/ci/repos");
    assert.equal(readList.status, 200, "read tokens can list repos");
    const readDispatch = await readApi("POST", "/api/ci/dispatch", { repo: "yolo-maxi/e2e-repo" });
    assert.equal(readDispatch.status, 403, "read tokens cannot dispatch CI");
    const readAdmin = await readApi("GET", "/api/ci/diagnostics");
    assert.equal(readAdmin.status, 403, "read tokens cannot see admin diagnostics");
  });
});
