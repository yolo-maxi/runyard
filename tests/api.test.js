import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_HUB_RUNYARD_MOBILE_FEEDBACK_SECRET = "shub_test_feedback_endpoint";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app, notifyTelegram } = await import("../src/server.js");
const { env } = await import("../src/env.js");
const { addRunEvent, autoQueueLegacyRunStartApprovals, createApproval, getRun, listRuns, transitionRun, updateRun } = await import("../src/db.js");
const {
  RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME,
  setRunObstructionAnalyzerForTest
} = await import("../src/runObstructionAnalysis.js");

let server;
let baseUrl;
const token = "shub_test_token";
const telegramEnvKeys = [
  "telegramBotToken",
  "telegramApprovalChatId",
  "telegramApprovalUserIds",
  "telegramChatId",
  "telegramThreadId",
  "telegramWebhookSecret",
  "baseUrl"
];

function withTelegramEnv(overrides) {
  const previous = Object.fromEntries(telegramEnvKeys.map((key) => [key, env[key]]));
  Object.assign(env, overrides);
  return () => Object.assign(env, previous);
}

function captureTelegramFetch(calls) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://api.telegram.org/")) {
      calls.push({
        url: href.replace(/bot[^/]+/, "bot<redacted>"),
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return previousFetch(url, options);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

// Generic outbound-fetch interceptor for response-endpoint delivery tests.
// Each handler matches by URL prefix or regex; unmatched calls pass through
// to the previous fetch so the in-process test API itself keeps working.
function captureOutboundFetch(handlers) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    for (const [match, handler] of handlers) {
      const hit = match instanceof RegExp ? match.test(href) : href.startsWith(match);
      if (hit) return handler({ url: href, options });
    }
    return previousFetch(url, options);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

async function waitForResponseEndpointStatus(runId, status, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await api(`/api/runs/${runId}`);
    const found = (detail.responseEndpoints || []).find((entry) => entry.deliveryStatus === status);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`timed out waiting for response endpoint deliveryStatus=${status}`);
}

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

// Raw request that returns status without throwing, with an optional bearer token override.
function raw(pathname, options = {}, bearer = token) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const data = text && contentType.includes("application/json") ? JSON.parse(text) : text || null;
    return { status: response.status, data, headers: response.headers };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLatestRunByCapability(capabilitySlug, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = listRuns({ limit: 200 }).find((entry) => entry.capabilitySlug === capabilitySlug);
    if (run) return run;
    await sleep(20);
  }
  throw new Error(`timed out waiting for capability run ${capabilitySlug}`);
}

async function waitForArtifact(runId, name, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { artifacts } = await api(`/api/runs/${runId}/artifacts`);
    const artifact = artifacts.find((entry) => entry.name === name);
    if (artifact) return artifact;
    await sleep(20);
  }
  throw new Error(`timed out waiting for artifact ${name}`);
}

async function waitForEvent(runId, type, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { events } = await api(`/api/runs/${runId}/events`);
    const event = events.find((entry) => entry.type === type);
    if (event) return event;
    await sleep(20);
  }
  throw new Error(`timed out waiting for event ${type}`);
}

function fakeObstructionAnalysis(overrides = {}) {
  return {
    severity: overrides.severity || "medium",
    confidence: overrides.confidence || "medium",
    summary: overrides.summary || "Bounded fake obstruction analysis.",
    observations: [
      {
        evidence: overrides.evidence || "warning/retry evidence in redacted event summary",
        inference: overrides.inference || "The run had avoidable friction.",
        severity: overrides.observationSeverity || "low",
        confidence: overrides.observationConfidence || "medium"
      }
    ],
    obstructions: overrides.obstructions || [],
    suggestedWorkflowImprovements: overrides.suggestedWorkflowImprovements || ["Summarize retry/fallback counts in workflow output."],
    suggestedAgentImprovements: overrides.suggestedAgentImprovements || ["Call out successful-but-painful runs in the final response."],
    suggestedSkillOrKnowledgeImprovements:
      overrides.suggestedSkillOrKnowledgeImprovements || ["Document recurring runner/tool issues as reusable knowledge."],
    followUpQuestions: overrides.followUpQuestions || ["Was this retry expected for the runner?"],
    doNotAutoMutate: false
  };
}

function signedTelegramInitData({ botToken, userId, authDate = Math.floor(Date.now() / 1000), hashOverride = "", user = {} }) {
  const params = new URLSearchParams({
    query_id: "AAE-test-query",
    user: JSON.stringify({ id: userId, first_name: "Operator", username: "operator", ...user }),
    auth_date: String(authDate)
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hashOverride || hash);
  return params.toString();
}

function firstCookie(setCookie) {
  return String(setCookie || "").split(";")[0];
}

async function createCheckpointApproval(capabilitySlug, input = {}) {
  const created = await api(`/api/capabilities/${capabilitySlug}/run`, {
    method: "POST",
    body: { input }
  });
  updateRun(created.run.id, { status: "waiting_approval", current_step: "waiting for checkpoint approval" });
  const approval = createApproval({
    runId: created.run.id,
    title: `Approve checkpoint for ${capabilitySlug}`,
    description: "Workflow checkpoint approval.",
    requestedBy: "token: bootstrap-admin",
    payload: {
      kind: "checkpoint",
      approvalKind: "checkpoint",
      approvalScope: "workflow_checkpoint",
      capability: capabilitySlug,
      input
    }
  });
  return { created, approval };
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
});

describe("Smithers Hub API", () => {
  it("authenticates with bootstrap token", async () => {
    const data = await api("/api/me");
    assert.equal(data.token.name, "bootstrap-admin");
  });

  it("lists seeded capabilities, agents, skills, and knowledge", async () => {
    const caps = await api("/api/capabilities");
    const agents = await api("/api/agents");
    const skills = await api("/api/skills");
    const knowledge = await api("/api/knowledge");
    assert.ok(caps.capabilities.find((cap) => cap.slug === "hello"));
    assert.ok(caps.capabilities.find((cap) => cap.slug === "runyard-support-agent"));
    assert.ok(agents.agents.length >= 4);
    assert.ok(skills.skills.length >= 4);
    assert.ok(knowledge.knowledge.length >= 1);
  });

  it("answers support chat through an internal runner-backed workflow without API keys", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const status = await api("/api/chat/status");
    assert.equal(status.configured, true);
    assert.equal(status.provider, "runner");
    assert.equal(status.model, "runyard-support-agent");

    const pending = api("/api/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "what page am I on?" }],
        context: { view: "runs", hash: "#runs", title: "Runyard" }
      }
    });

    const run = await waitForLatestRunByCapability("runyard-support-agent");
    assert.equal(run.status, "queued");
    transitionRun(run.id, "running", { current_step: "test runner" });
    transitionRun(run.id, "succeeded", {
      current_step: "done",
      output: { outputs: { support: { reply: "You are on the runs page." } } }
    });

    const result = await pending;
    assert.equal(result.provider, "runner");
    assert.equal(result.model, "runyard-support-agent");
    assert.equal(result.reply, "You are on the runs page.");
  });

  it("renders support chat actions as explicit choice buttons instead of auto-running them", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    assert.match(code, /parseAgentResponse/);
    assert.match(code, /normalizeSupportButtons/);
    assert.match(code, /support-chat-choice/);
    assert.match(code, /activateSupportButton/);
    assert.match(code, /legacyActions/);
    assert.match(code, /label: "Do it"/);
    assert.doesNotMatch(code, /parseAgentActions/);
  });

  it("enriches the support chat prompt with real, redacted run data from the operator's screen", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // Seed a failed run with a secret-shaped input field the agent must not see.
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "Probe the failure", apiKey: "sk-leak-me-please-1234567890" } }
    });
    const targetRunId = created.run.id;
    transitionRun(targetRunId, "running", { current_step: "build" });
    addRunEvent(targetRunId, "run.failed", "Run failed: boom in build", {});
    transitionRun(targetRunId, "failed", { current_step: "build", error: "boom in build" });

    // Snapshot existing support runs so we wait for OUR new one, not a stale
    // support run left queued/succeeded by an earlier test.
    const existing = new Set(
      listRuns({ limit: 500 }).filter((r) => r.capabilitySlug === "runyard-support-agent").map((r) => r.id)
    );
    const pending = api("/api/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "why did this fail?" }],
        context: { view: "runs", hash: `#runs/${targetRunId}`, title: "Runyard" }
      }
    });

    let supportRun = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !supportRun) {
      supportRun = listRuns({ limit: 500 }).find(
        (r) => r.capabilitySlug === "runyard-support-agent" && !existing.has(r.id)
      );
      if (!supportRun) await sleep(20);
    }
    assert.ok(supportRun, "expected a new support-agent run to be created");
    const system = String(getRun(supportRun.id)?.input?.system || "");
    assert.match(system, /Live app data/);
    assert.match(system, new RegExp(targetRunId));
    assert.match(system, /boom in build/);
    // The seeded secret must never reach the model prompt.
    assert.doesNotMatch(system, /sk-leak-me-please/);

    transitionRun(supportRun.id, "running", { current_step: "test runner" });
    transitionRun(supportRun.id, "succeeded", {
      current_step: "done",
      output: { outputs: { support: { reply: "It failed because the build threw." } } }
    });
    const result = await pending;
    assert.equal(result.reply, "It failed because the build threw.");
  });

  it("ships the snappy persistent-chat + contextual quick-reply code paths in the bundle", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    // Contextual quick replies + the bar that renders them.
    assert.match(code, /supportQuickReplies/);
    assert.match(code, /renderSupportQuickReplies/);
    assert.match(code, /data-quick-prompt/);
    // Snappiness: optimistic typing indicator.
    assert.match(code, /support-chat-typing/);
    // No-flicker: route sync only touches the chip bar, draft persists per tab.
    assert.match(code, /syncSupportChatToRoute/);
    assert.match(code, /restoreSupportDraft/);
  });

  it("creates a run, registers a runner, claims it, stores events and artifacts, and completes", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "Test Smithers Hub" } }
    });
    assert.equal(created.run.status, "queued");
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "test runner", hostname: "test", platform: "linux", tags: ["smithers", "node"] }
    });
    const assignment = await api(`/api/runners/${runner.runner.id}/next-run`);
    assert.equal(assignment.run.id, created.run.id);
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/events`, { method: "POST", body: { type: "workflow.step", message: "testing" } });
    await api(`/api/runs/${created.run.id}/artifacts`, {
      method: "POST",
      body: { name: "result.md", mimeType: "text/markdown", contentBase64: Buffer.from("# result").toString("base64") }
    });
    await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "succeeded");
    assert.equal(detail.artifacts.length, 2);
    const resultArtifact = detail.artifacts.find((artifact) => artifact.name === "result.md");
    const retrospective = detail.artifacts.find((artifact) => artifact.name === "run-retrospective.json");
    assert.ok(resultArtifact);
    assert.ok(retrospective);
    assert.equal(readFileSync(resultArtifact.path, "utf8"), "# result");
    assert.ok(resultArtifact.path.includes(path.join("artifacts", "runs", "hello", detail.run.createdAt.slice(0, 10), created.run.id)));
    assert.equal(resultArtifact.deepLink, `/app#runs/${created.run.id}/artifacts/${resultArtifact.id}`);
    assert.equal(resultArtifact.deepLinkRun, `/app#runs/${created.run.id}`);
    const retrospectiveContent = JSON.parse(readFileSync(retrospective.path, "utf8"));
    assert.equal(retrospectiveContent.schemaVersion, "smithers.hub.run-retrospective.v1");
    assert.equal(retrospectiveContent.run.id, created.run.id);
    assert.equal(retrospectiveContent.run.status, "succeeded");
    assert.equal(retrospectiveContent.policy.autoMutations, false);
    assert.equal(retrospectiveContent.evidence.artifactInventory.some((artifact) => artifact.name === "result.md"), true);
    const runArtifacts = await api(`/api/runs/${created.run.id}/artifacts`);
    assert.ok(runArtifacts.artifacts.every((artifact) => artifact.deepLink === `/app#runs/${created.run.id}/artifacts/${artifact.id}`));
  });

  it("stores a retrospective artifact for failed runs without workflow-authored output", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "fail with retrospective" } }
    });
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/events`, {
      method: "POST",
      body: { type: "workflow.step", message: "validating failure capture" }
    });
    await api(`/api/runs/${created.run.id}/fail`, { method: "POST", body: { error: "synthetic test failure" } });

    const artifacts = await api(`/api/runs/${created.run.id}/artifacts`);
    const retrospective = artifacts.artifacts.find((artifact) => artifact.name === "run-retrospective.json");
    assert.ok(retrospective);
    const content = JSON.parse(readFileSync(retrospective.path, "utf8"));
    assert.equal(content.run.status, "failed");
    assert.equal(content.outcome.succeeded, false);
    assert.equal(content.outcome.diagnostics.headline, "synthetic test failure");
    assert.equal(content.notes.some((note) => note.includes("did not modify workflows")), true);
  });

  it("stores a retrospective artifact when a stale run is auto-failed", async () => {
    const previousDeadline = env.runDeadlineMs;
    env.runDeadlineMs = 1;
    setRunObstructionAnalyzerForTest(async () => ({
      provider: "test",
      model: "fake",
      analysis: fakeObstructionAnalysis({ severity: "high", summary: "Stale run exceeded the deadline." })
    }));
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "timeout retrospective" } }
      });
      updateRun(created.run.id, {
        status: "running",
        current_step: "stale runner",
        assigned_at: "2000-01-01T00:00:00.000Z",
        started_at: "2000-01-01T00:00:00.000Z"
      });

      await api("/api/runs");
      const detail = await api(`/api/runs/${created.run.id}`);
      assert.equal(detail.run.status, "failed");
      const retrospective = detail.artifacts.find((artifact) => artifact.name === "run-retrospective.json");
      assert.ok(retrospective);
      const content = JSON.parse(readFileSync(retrospective.path, "utf8"));
      assert.match(content.outcome.diagnostics.reason, /^run exceeded execution deadline/);
      const obstruction = await waitForArtifact(created.run.id, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
      const obstructionContent = JSON.parse(readFileSync(obstruction.path, "utf8"));
      assert.equal(obstructionContent.run.status, "failed");
      assert.equal(obstructionContent.doNotAutoMutate, true);
    } finally {
      env.runDeadlineMs = previousDeadline;
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("stores obstruction analysis for a successful terminal run with warning and retry evidence", async () => {
    const analyzerCalls = [];
    setRunObstructionAnalyzerForTest(async (request) => {
      analyzerCalls.push(request);
      assert.equal(request.promptPayload.includes("shub_success_secret"), false);
      assert.ok(request.payload.evidence.detectedSignals.successfulButPainful);
      return {
        provider: "test",
        model: "fake",
        analysis: fakeObstructionAnalysis({
          severity: "low",
          summary: "Successful run had retry friction.",
          evidence: "warning and retry events were present",
          inference: "The task completed but was noisier than necessary."
        })
      };
    });
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "success with retry evidence", token: "shub_success_secret" } }
      });
      await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
      updateRun(created.run.id, {
        started_at: new Date(Date.now() - 25 * 60_000).toISOString()
      });
      await api(`/api/runs/${created.run.id}/events`, {
        method: "POST",
        body: {
          type: "workflow.step",
          message: "Retrying package install after transient warning token=shub_success_secret"
        }
      });
      await api(`/api/runs/${created.run.id}/events`, {
        method: "POST",
        body: { type: "runner.warning", message: "fallback path used after retry" }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true, secret: "raw-output" } } });

      const obstruction = await waitForArtifact(created.run.id, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
      const content = JSON.parse(readFileSync(obstruction.path, "utf8"));
      assert.equal(content.schemaVersion, "smithers.hub.run-obstruction-analysis.v1");
      assert.equal(content.run.status, "succeeded");
      assert.equal(content.severity, "low");
      assert.equal(content.doNotAutoMutate, true);
      assert.equal(content.policy.autoMutations, false);
      assert.equal(content.evidence.detectedSignals.successfulButPainful, true);
      assert.equal(content.observations[0].evidence, "warning and retry events were present");
      assert.equal(JSON.stringify(content).includes("shub_success_secret"), false);
      assert.equal(JSON.stringify(content).includes("raw-output"), false);
      assert.equal(analyzerCalls.length, 1);
    } finally {
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("stores obstruction analysis for a failed terminal run", async () => {
    setRunObstructionAnalyzerForTest(async () => ({
      provider: "test",
      model: "fake",
      analysis: fakeObstructionAnalysis({
        severity: "high",
        confidence: "high",
        summary: "Failed run hit a build obstruction.",
        obstructions: [
          {
            category: "tool",
            evidence: "run.failed event and diagnostic error",
            inference: "The build step was blocked by a tool failure.",
            severity: "high",
            confidence: "high"
          }
        ]
      })
    }));
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "failed obstruction" } }
      });
      await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
      await api(`/api/runs/${created.run.id}/events`, {
        method: "POST",
        body: { type: "workflow.step", message: "building artifact" }
      });
      await api(`/api/runs/${created.run.id}/fail`, { method: "POST", body: { error: "synthetic failure for obstruction" } });

      const obstruction = await waitForArtifact(created.run.id, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
      const retrospective = (await api(`/api/runs/${created.run.id}/artifacts`)).artifacts.find((artifact) => artifact.name === "run-retrospective.json");
      assert.ok(retrospective, "deterministic retrospective should still be present");
      const content = JSON.parse(readFileSync(obstruction.path, "utf8"));
      assert.equal(content.run.status, "failed");
      assert.equal(content.outcome.succeeded, false);
      assert.equal(content.severity, "high");
      assert.equal(content.obstructions[0].category, "tool");
      assert.equal(content.doNotAutoMutate, true);
    } finally {
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("records obstruction analysis failure without blocking terminalization", async () => {
    setRunObstructionAnalyzerForTest(async () => {
      throw new Error("provider unavailable token=shub_failure_secret");
    });
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "analysis failure" } }
      });
      await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
      const failed = await raw(`/api/runs/${created.run.id}/fail`, {
        method: "POST",
        body: { error: "terminal failure still succeeds" }
      });
      assert.equal(failed.status, 200);
      assert.equal(failed.data.run.status, "failed");

      const event = await waitForEvent(created.run.id, "run.obstruction_analysis_failed");
      assert.match(event.data.error, /provider unavailable/);
      assert.equal(event.data.error.includes("shub_failure_secret"), false);
      const artifacts = await api(`/api/runs/${created.run.id}/artifacts`);
      assert.ok(artifacts.artifacts.find((artifact) => artifact.name === "run-retrospective.json"));
      assert.equal(artifacts.artifacts.some((artifact) => artifact.name === RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME), false);
    } finally {
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("does not duplicate obstruction artifacts when terminalization is retried", async () => {
    let calls = 0;
    setRunObstructionAnalyzerForTest(async () => {
      calls += 1;
      return { provider: "test", model: "fake", analysis: fakeObstructionAnalysis({ severity: "medium" }) };
    });
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "dedupe obstruction" } }
      });
      await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
      await api(`/api/runs/${created.run.id}/events`, {
        method: "POST",
        body: { type: "runner.warning", message: "retrying once before completion" }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      await waitForArtifact(created.run.id, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
      const retried = await raw(`/api/runs/${created.run.id}/complete`, {
        method: "POST",
        body: { output: { ok: true } }
      });
      assert.equal(retried.status, 200);
      await sleep(100);
      const artifacts = await api(`/api/runs/${created.run.id}/artifacts`);
      assert.equal(artifacts.artifacts.filter((artifact) => artifact.name === RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME).length, 1);
      assert.equal(calls, 1);
    } finally {
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("queues the next chained workflow when a run completes", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { goal: "first step" },
        chain: [{ capability: "hello", input: { goal: "second step" } }]
      }
    });
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    const completed = await api(`/api/runs/${created.run.id}/complete`, {
      method: "POST",
      body: { output: { answer: 42 } }
    });
    assert.equal(completed.run.status, "succeeded");
    assert.ok(completed.chainedRun, "completion should queue the next chained run");
    assert.equal(completed.chainedRun.capabilitySlug, "hello");
    assert.equal(completed.chainedRun.status, "queued");

    const child = await api(`/api/runs/${completed.chainedRun.id}`);
    assert.equal(child.run.input.goal, "second step");
    assert.equal(child.run.input.__chainIndex, 1);
    assert.equal(child.run.input.previousRun.id, created.run.id);
    assert.equal(child.run.input.previousOutput.answer, 42);
    assert.equal(child.run.origin.type, "workflow-chain");
    const parentEvents = await api(`/api/runs/${created.run.id}/events`);
    assert.ok(parentEvents.events.find((event) => event.type === "run.chain.queued"));
  });

  it("starts implement workflows without a run-start approval", async () => {
    const created = await api("/api/capabilities/implement/run", {
      method: "POST",
      body: { input: { repo: "/tmp", task: "test" } }
    });
    assert.equal(created.run.status, "queued");
    const approvals = await api("/api/approvals?status=pending");
    const approval = approvals.approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("records explicit command origin on runs", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      headers: {
        "x-smithers-origin": "telegram group 'Smithers Hub'",
        "x-smithers-origin-message-id": "28334"
      },
      body: { input: { goal: "origin test" } }
    });
    assert.equal(created.run.originLabel, "telegram group 'Smithers Hub'");
    assert.equal(created.run.origin.messageId, "28334");
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.originLabel, "telegram group 'Smithers Hub'");
    assert.equal(detail.run.input.__origin.label, "telegram group 'Smithers Hub'");
  });

  it("can rerun a previous run with a new linked run", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "rerun me" } }
    });
    const rerun = await api(`/api/runs/${created.run.id}/rerun`, { method: "POST", body: {} });
    assert.equal(rerun.run.status, "queued");
    assert.equal(rerun.run.input.goal, "rerun me");
    assert.equal(rerun.run.input.rerunOf, created.run.id);
    assert.equal(rerun.run.origin.type, "hub-rerun");
    assert.equal(rerun.run.origin.previousRunId, created.run.id);
    assert.notEqual(rerun.run.id, created.run.id);

    const edited = await api(`/api/runs/${created.run.id}/rerun`, {
      method: "POST",
      body: { input: { goal: "rerun me, but edited" } }
    });
    assert.equal(edited.run.status, "queued");
    assert.equal(edited.run.input.goal, "rerun me, but edited");
    assert.equal(edited.run.input.rerunOf, created.run.id);
    assert.equal(edited.run.origin.type, "hub-rerun");
  });
});

describe("Run response endpoints (slice 1)", () => {
  it("creates a run without a responseEndpoint unchanged", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "no response endpoint" } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(Object.hasOwn(created, "responseEndpoint"), false);
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.deepEqual(detail.responseEndpoints, []);
  });

  it("persists a valid http response endpoint with a redacted summary", async () => {
    const secretHeader = "Bearer shub_response_endpoint_secret_token";
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { goal: "with http response endpoint" },
        responseEndpoint: {
          type: "http",
          config: {
            url: "https://app.example.com/webhooks/runyard?token=callback-secret&visible=ok",
            method: "POST",
            headers: { authorization: secretHeader, "x-app-tenant": "tenant-42" }
          }
        }
      }
    });
    assert.equal(created.run.status, "queued");
    assert.ok(created.responseEndpoint, "POST run reply should echo the registered endpoint");
    assert.equal(created.responseEndpoint.type, "http");
    assert.equal(created.responseEndpoint.deliveryStatus, "pending");
    assert.equal(created.responseEndpoint.deliveryAttempts, 0);
    assert.equal(created.responseEndpoint.summary.method, "POST");
    assert.match(created.responseEndpoint.summary.url, /token=%5Bredacted%5D|token=\[redacted\]/);
    assert.match(created.responseEndpoint.summary.url, /visible=ok/);
    assert.equal(created.responseEndpoint.summary.headerCount, 2);
    const headerNames = created.responseEndpoint.summary.headerNames;
    assert.ok(headerNames.find((entry) => entry.startsWith("authorization") && entry.includes("[redacted]")));
    assert.ok(headerNames.includes("x-app-tenant"));
    // No raw bearer value or callback-secret string leaks anywhere on the wire.
    const createdJson = JSON.stringify(created);
    assert.equal(createdJson.includes(secretHeader), false);
    assert.equal(createdJson.includes("callback-secret"), false);

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.responseEndpoints.length, 1);
    assert.equal(detail.responseEndpoints[0].type, "http");
    assert.equal(detail.responseEndpoints[0].deliveryStatus, "pending");
    const detailJson = JSON.stringify(detail);
    assert.equal(detailJson.includes(secretHeader), false);
    assert.equal(detailJson.includes("callback-secret"), false);

    const events = await api(`/api/runs/${created.run.id}/events`);
    const registered = events.events.find((event) => event.type === "run.response_endpoint.registered");
    assert.ok(registered, "should emit a run event when the response endpoint is registered");
    const eventsJson = JSON.stringify(events);
    assert.equal(eventsJson.includes(secretHeader), false);
    assert.equal(eventsJson.includes("callback-secret"), false);

    const audit = await api("/api/audit?limit=200");
    const entry = audit.audit.find(
      (item) => item.action === "run.response_endpoint.registered" && item.target === created.run.id
    );
    assert.ok(entry, "registering a response endpoint should be audited");
    const auditJson = JSON.stringify(entry);
    assert.equal(auditJson.includes(secretHeader), false);
    assert.equal(auditJson.includes("callback-secret"), false);
  });

  it("persists a valid telegram response endpoint with a redacted summary", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { goal: "with telegram response endpoint" },
        responseEndpoint: {
          type: "telegram",
          config: { chatId: "-1009876543210", threadId: 7, parseMode: "MarkdownV2" }
        }
      }
    });
    assert.equal(created.run.status, "queued");
    assert.ok(created.responseEndpoint);
    assert.equal(created.responseEndpoint.type, "telegram");
    assert.equal(created.responseEndpoint.summary.chatId, "-1009876543210");
    assert.equal(created.responseEndpoint.summary.threadId, 7);
    assert.equal(created.responseEndpoint.summary.parseMode, "MarkdownV2");

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.responseEndpoints.length, 1);
    assert.equal(detail.responseEndpoints[0].summary.chatId, "-1009876543210");
  });

  it("does not schedule delivery for runs without a responseEndpoint", async () => {
    let outboundCalls = 0;
    const restoreFetch = captureOutboundFetch([
      [/^https:\/\/.*\/runyard-no-endpoint/, async () => {
        outboundCalls += 1;
        return new Response("", { status: 200 });
      }]
    ]);
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "no endpoint = no delivery" } }
      });
      await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      await sleep(60);
      const detail = await api(`/api/runs/${created.run.id}`);
      assert.deepEqual(detail.responseEndpoints, []);
      assert.equal(outboundCalls, 0);
      const events = await api(`/api/runs/${created.run.id}/events`);
      assert.equal(events.events.some((event) => event.type.startsWith("run.response_endpoint.")), false);
    } finally {
      restoreFetch();
    }
  });

  it("rejects malformed responseEndpoint with 400 and does not create a run", async () => {
    const runsBefore = await api("/api/runs?limit=1");
    const before = runsBefore.total;

    const cases = [
      { responseEndpoint: "https://bad.example" }, // not an object
      { responseEndpoint: { type: "email", config: { to: "a@b.c" } } }, // unsupported type
      { responseEndpoint: { type: "http" } }, // no config
      { responseEndpoint: { type: "http", config: { url: "not-a-url" } } }, // bad URL
      { responseEndpoint: { type: "http", config: { url: "ftp://example.com/x" } } }, // wrong scheme
      { responseEndpoint: { type: "http", config: { url: "https://example.com", method: "DELETE" } } },
      {
        responseEndpoint: {
          type: "http",
          config: { url: "https://example.com", headers: { "bad header name!": "x" } }
        }
      },
      {
        responseEndpoint: {
          type: "http",
          config: { url: "https://example.com", headers: { "x-ok": 42 } }
        }
      },
      { responseEndpoint: { type: "telegram", config: {} } }, // missing chatId
      {
        responseEndpoint: {
          type: "telegram",
          config: { chatId: "123", parseMode: "fancy" }
        }
      },
      {
        responseEndpoint: {
          type: "telegram",
          config: { chatId: "123", threadId: "not-a-number" }
        }
      }
    ];
    for (const body of cases) {
      const result = await raw("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "rejected" }, ...body }
      });
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body.responseEndpoint)}`);
    }

    const runsAfter = await api("/api/runs?limit=1");
    assert.equal(runsAfter.total, before, "rejected responseEndpoint requests must not create runs");
  });
});

describe("Run response endpoints (slice 2 — delivery)", () => {
  // Slice 2 only needs a run that reaches a terminal state. The bootstrap
  // admin token bypasses runner-ownership, so we can drive a queued → running
  // transition directly instead of registering a runner and racing the global
  // queue ordering. /complete after /start lands the run in `succeeded` and
  // fires the terminal-state hooks.
  async function startedRun(body) {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body });
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    return created;
  }

  it("delivers a sanitized payload to an http endpoint and stamps delivered_at", async () => {
    const secretHeader = "Bearer shub_delivery_http_secret_value_xyz";
    const calls = [];
    const restoreFetch = captureOutboundFetch([
      ["https://app.example.com/webhooks/delivery-ok", async ({ url, options }) => {
        calls.push({
          url,
          method: options.method,
          headers: options.headers,
          body: options.body ? JSON.parse(options.body) : null
        });
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }]
    ]);
    try {
      const created = await startedRun({
        input: { goal: "http delivery", secret: "shub_run_input_secret_should_not_leak" },
        responseEndpoint: {
          type: "http",
          config: {
            url: "https://app.example.com/webhooks/delivery-ok?token=callback-token-secret",
            method: "POST",
            headers: { authorization: secretHeader, "x-app-tenant": "tenant-1" }
          }
        }
      });
      await api(`/api/runs/${created.run.id}/complete`, {
        method: "POST",
        body: { output: { ok: true, secret: "shub_output_secret_leaks_here_no" } }
      });
      const delivered = await waitForResponseEndpointStatus(created.run.id, "delivered");
      assert.equal(delivered.type, "http");
      assert.equal(delivered.deliveryStatus, "delivered");
      assert.equal(delivered.deliveryAttempts, 1);
      assert.ok(delivered.lastAttemptAt);
      assert.ok(delivered.deliveredAt);
      assert.equal(delivered.lastError, null);

      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.method, "POST");
      // The configured headers are forwarded blind on the outbound request
      // (that's what they're for) but never echoed into any Hub record.
      assert.equal(call.headers.authorization, secretHeader);
      assert.equal(call.headers["x-app-tenant"], "tenant-1");
      // Payload-side: schema fields and pointers, no raw config / no secret values.
      assert.equal(call.body.schemaVersion, "runyard.run.response.v1");
      assert.equal(call.body.runId, created.run.id);
      assert.equal(call.body.status, "succeeded");
      assert.equal(call.body.capability.slug, "hello");
      assert.ok(call.body.links.run.includes(created.run.id));
      // Output is summarized — key names only, no raw values.
      assert.equal(call.body.output.kind, "object");
      assert.deepEqual(call.body.output.keys.sort(), ["ok", "secret"]);
      const bodyJson = JSON.stringify(call.body);
      assert.equal(bodyJson.includes("shub_output_secret_leaks_here_no"), false);
      assert.equal(bodyJson.includes("shub_run_input_secret_should_not_leak"), false);
      assert.equal(bodyJson.includes(secretHeader), false);
      assert.equal(bodyJson.includes("callback-token-secret"), false);

      // Run event + audit refer to the redacted endpoint summary, not the body.
      const events = await api(`/api/runs/${created.run.id}/events`);
      const ok = events.events.find((event) => event.type === "run.response_endpoint.delivered");
      assert.ok(ok);
      const eventJson = JSON.stringify(ok);
      assert.equal(eventJson.includes(secretHeader), false);
      assert.equal(eventJson.includes("callback-token-secret"), false);
    } finally {
      restoreFetch();
    }
  });

  it("records http delivery failure with status and attempt metadata", async () => {
    const calls = [];
    const restoreFetch = captureOutboundFetch([
      ["https://app.example.com/webhooks/delivery-fail", async ({ url }) => {
        calls.push({ url });
        return new Response("nope", { status: 502 });
      }]
    ]);
    try {
      const created = await startedRun({
        input: { goal: "http delivery failure" },
        responseEndpoint: {
          type: "http",
          config: { url: "https://app.example.com/webhooks/delivery-fail", method: "POST" }
        }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      const failed = await waitForResponseEndpointStatus(created.run.id, "failed");
      assert.equal(failed.type, "http");
      assert.equal(failed.deliveryAttempts, 1);
      assert.ok(failed.lastAttemptAt);
      assert.equal(failed.deliveredAt, null);
      assert.match(failed.lastError || "", /502/);
      assert.equal(calls.length, 1);
      const events = await api(`/api/runs/${created.run.id}/events`);
      const fail = events.events.find((event) => event.type === "run.response_endpoint.delivery_failed");
      assert.ok(fail);
      assert.equal(fail.data.httpStatus, 502);
    } finally {
      restoreFetch();
    }
  });

  it("delivers a concise telegram message when the bot token is configured", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "123:test-bot-token-for-delivery",
      baseUrl: "https://hub.example"
    });
    try {
      const created = await startedRun({
        input: { goal: "telegram delivery" },
        responseEndpoint: {
          type: "telegram",
          config: { chatId: "-1009998887", threadId: 11, parseMode: "MarkdownV2" }
        }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      const delivered = await waitForResponseEndpointStatus(created.run.id, "delivered");
      assert.equal(delivered.type, "telegram");
      const send = calls.find((call) => call.url.endsWith("/sendMessage"));
      assert.ok(send, "telegram delivery should hit sendMessage");
      assert.equal(send.body.chat_id, "-1009998887");
      assert.equal(send.body.message_thread_id, 11);
      assert.equal(send.body.parse_mode, "MarkdownV2");
      assert.match(send.body.text, /SUCCEEDED/);
      assert.match(send.body.text, new RegExp(created.run.id));
      assert.match(send.body.text, /https:\/\/hub\.example\/app#runs\//);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("records telegram delivery failure when the bot token is not configured", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({ telegramBotToken: "" });
    try {
      const created = await startedRun({
        input: { goal: "telegram delivery missing token" },
        responseEndpoint: {
          type: "telegram",
          config: { chatId: "-1001112223334" }
        }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      const failed = await waitForResponseEndpointStatus(created.run.id, "failed");
      assert.equal(failed.type, "telegram");
      assert.equal(failed.deliveryAttempts, 1);
      assert.equal(failed.deliveredAt, null);
      assert.match(failed.lastError || "", /TELEGRAM_BOT_TOKEN/);
      assert.equal(calls.length, 0, "missing token must not hit api.telegram.org");
      // The run itself is still succeeded — delivery failure does not affect the run.
      const detail = await api(`/api/runs/${created.run.id}`);
      assert.equal(detail.run.status, "succeeded");
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("does not redeliver an endpoint that is already delivered", async () => {
    const calls = [];
    const restoreFetch = captureOutboundFetch([
      ["https://app.example.com/webhooks/delivery-once", async ({ url, options }) => {
        calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return new Response("", { status: 200 });
      }]
    ]);
    try {
      const created = await startedRun({
        input: { goal: "no duplicate" },
        responseEndpoint: {
          type: "http",
          config: { url: "https://app.example.com/webhooks/delivery-once" }
        }
      });
      await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      await waitForResponseEndpointStatus(created.run.id, "delivered");
      assert.equal(calls.length, 1);

      // A repeated terminal-state POST is idempotent; no second outbound call.
      const retried = await raw(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
      assert.equal(retried.status, 200);
      await sleep(100);
      assert.equal(calls.length, 1, "delivered endpoint must not receive a duplicate delivery");

      const detail = await api(`/api/runs/${created.run.id}`);
      assert.equal(detail.responseEndpoints[0].deliveryStatus, "delivered");
      assert.equal(detail.responseEndpoints[0].deliveryAttempts, 1);
    } finally {
      restoreFetch();
    }
  });
});

describe("Hardening: scopes, tokens, run state, webhook, health", () => {
  it("exposes an unauthenticated health endpoint", async () => {
    const res = await raw("/healthz", {}, null);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
  });

  it("enforces token scopes", async () => {
    // A read/run-only token (mcp) must not be able to mint tokens or edit the catalog.
    const created = await api("/api/tokens", { method: "POST", body: { name: "mcp-only", scopes: ["mcp"] } });
    const mcpToken = created.token.token;
    assert.ok(mcpToken);

    // Allowed: read capabilities and run them.
    const list = await raw("/api/capabilities", {}, mcpToken);
    assert.equal(list.status, 200);
    const run = await raw("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "scoped" } } }, mcpToken);
    assert.equal(run.status, 202);

    // Denied: minting tokens and editing the catalog require admin.
    const mint = await raw("/api/tokens", { method: "POST", body: { name: "evil", scopes: ["admin"] } }, mcpToken);
    assert.equal(mint.status, 403);
    const edit = await raw("/api/capabilities", { method: "POST", body: { name: "x" } }, mcpToken);
    assert.equal(edit.status, 403);
  });

  it("lists and revokes tokens, and revoked tokens stop working", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "throwaway", scopes: ["api", "mcp"] } });
    const id = created.token.id;
    const value = created.token.token;
    assert.equal((await raw("/api/me", {}, value)).status, 200);

    const list = await api("/api/tokens");
    assert.ok(list.tokens.find((entry) => entry.id === id && entry.active));

    await api(`/api/tokens/${id}`, { method: "DELETE" });
    assert.equal((await raw("/api/me", {}, value)).status, 401);
  });

  it("refuses to revoke the last active admin token", async () => {
    const me = await api("/api/me");
    const res = await raw(`/api/tokens/${me.token.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);
  });

  it("guards run state transitions", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "state" } } });
    const runId = created.run.id;
    // A genuinely invalid (non-terminal) transition is still rejected: a queued
    // run cannot jump straight to succeeded without being assigned/running.
    const earlyComplete = await raw(`/api/runs/${runId}/complete`, { method: "POST", body: { output: {} } });
    assert.equal(earlyComplete.status, 409);
    await api(`/api/runs/${runId}/cancel`, { method: "POST", body: { reason: "stop" } });
    // Re-cancelling a cancelled run is idempotent.
    const reCancel = await raw(`/api/runs/${runId}/cancel`, { method: "POST", body: {} });
    assert.equal(reCancel.status, 200);
    assert.equal(reCancel.data.run.status, "cancelled");
  });

  it("treats a late terminal report after cancellation as a benign no-op (transition race)", async () => {
    // Reproduces the runner-log noise: a supervised child is cancelled, then the
    // runner finishes a beat later and reports complete/fail. The first terminal
    // state (cancelled) must win, the late report must NOT 409, and a calm
    // run.transition_ignored event should explain the race.
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "race" } } });
    const runId = created.run.id;
    const runner = await api("/api/runners/register", { method: "POST", body: { name: "race", hostname: "race", tags: ["smithers"] } });
    await api(`/api/runners/${runner.runner.id}/next-run`); // assign
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} }); // running
    await api(`/api/runs/${runId}/cancel`, { method: "POST", body: { reason: "operator stop" } });

    const lateComplete = await raw(`/api/runs/${runId}/complete`, { method: "POST", body: { output: { ok: true } } });
    assert.equal(lateComplete.status, 200, "late complete after cancel must not 409");
    assert.equal(lateComplete.data.run.status, "cancelled", "operator cancellation wins");

    const lateFail = await raw(`/api/runs/${runId}/fail`, { method: "POST", body: { error: "boom" } });
    assert.equal(lateFail.status, 200, "late fail after cancel must not 409");
    assert.equal(lateFail.data.run.status, "cancelled");

    const detail = await api(`/api/runs/${runId}`);
    assert.equal(detail.run.status, "cancelled");
    assert.equal(detail.run.error || "", "", "late fail must not overwrite the cancelled run's error");
    const events = (await api(`/api/runs/${runId}/events`)).events || [];
    assert.ok(events.some((e) => e.type === "run.transition_ignored"), "should record a calm transition_ignored event");
    assert.ok(!events.some((e) => e.type === "run.succeeded"), "must not record a success event for the raced report");
  });

  it("does not double-assign a queued run to two runners", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "claim" } } });
    const a = await api("/api/runners/register", { method: "POST", body: { name: "a", hostname: "a", tags: ["smithers", "node"] } });
    const b = await api("/api/runners/register", { method: "POST", body: { name: "b", hostname: "b", tags: ["smithers", "node"] } });
    const claimA = await api(`/api/runners/${a.runner.id}/next-run`);
    const claimB = await api(`/api/runners/${b.runner.id}/next-run`);
    const claimed = [claimA, claimB].filter((c) => c.run && c.run.id === created.run.id);
    assert.equal(claimed.length, 1);
  });

  it("serves a one-line installer and a client bundle", async () => {
    const r1 = await fetch(`${baseUrl}/install.sh`);
    assert.equal(r1.status, 200);
    const body = await r1.text();
    assert.match(body, /Installing Smithers Hub client/);
    assert.match(body, /\/cli\.tgz/);
    assert.match(body, /runyard tail <run-id>/);
    assert.match(body, /runyard mcp install/);
    assert.match(body, /"\$BIN\/runyard"/);
    const r2 = await fetch(`${baseUrl}/cli.tgz`);
    assert.equal(r2.status, 200);
    const buf = Buffer.from(await r2.arrayBuffer());
    assert.equal(buf[0], 0x1f); // gzip magic
    assert.equal(buf[1], 0x8b);

    const appPage = await fetch(`${baseUrl}/app`);
    assert.equal(appPage.status, 200);
    const csp = appPage.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/);
    assert.equal(appPage.headers.get("x-frame-options"), null);
    assert.match(await appPage.text(), /https:\/\/telegram\.org\/js\/telegram-web-app\.js\?62/);
    const appJs = await fetch(`${baseUrl}/public/app.js`);
    assert.equal(appJs.status, 200);
    const appCode = await appJs.text();
    assert.match(appCode, /\/api\/auth\/telegram-webapp/);
    assert.match(appCode, /window\.Telegram\?\.WebApp/);
    assert.match(appCode, /ready\?\.\(\)/);
  });

  it("documents the unified run timeline endpoint in OpenAPI", async () => {
    const apiSpec = await raw("/openapi.json");
    assert.equal(apiSpec.status, 200);
    assert.ok(apiSpec.data.paths["/runs/{id}/timeline"]);
    assert.match(apiSpec.data.paths["/runs/{id}/timeline"].get.summary, /unified ascending run timeline/);
  });

  it("rejects unconfigured / unauthenticated Telegram webhook calls", async () => {
    // No TELEGRAM_WEBHOOK_SECRET configured in the test env -> endpoint disabled.
    const res = await raw("/api/telegram/webhook", { method: "POST", body: { callback_query: { data: "approve:appr_x" } } }, null);
    assert.equal(res.status, 503);
  });

  it("authenticates Telegram WebApp initData for the approval operator", async () => {
    const botToken = "123456:test-bot-secret";
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "123456789",
      telegramApprovalUserIds: "123456789"
    });
    try {
      const { created, approval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Telegram WebApp auth valid",
        deploy: false
      });

      const initData = signedTelegramInitData({ botToken, userId: 123456789 });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 200);
      const cookie = firstCookie(auth.headers.get("set-cookie"));
      assert.match(cookie, /^shub_session=/);

      const me = await raw("/api/me", { headers: { cookie } }, null);
      assert.equal(me.status, 200);
      assert.equal(me.data.token.id, "telegram-webapp:123456789");
      assert.deepEqual(me.data.token.scopes, ["approvals"]);

      assert.equal((await raw(`/api/approvals/${approval.id}`, { headers: { cookie } }, null)).status, 200);
      assert.equal((await raw(`/api/runs/${created.run.id}`, { headers: { cookie } }, null)).status, 200);
      assert.equal((await raw("/api/capabilities", { headers: { cookie } }, null)).status, 403);

      const changed = await raw(
        `/api/approvals/${approval.id}/request-changes`,
        { method: "POST", headers: { cookie }, body: { comment: "Please revise from Telegram miniapp." } },
        null
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.data.approval.decision, "changes_requested");
      assert.equal(changed.data.approval.resolvedBy, "telegram:operator");
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("rejects Telegram WebApp initData with an invalid hash", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "123456789",
      telegramApprovalUserIds: "123456789"
    });
    try {
      const initData = signedTelegramInitData({ botToken, userId: 123456789, hashOverride: "0".repeat(64) });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 401);
      assert.equal(auth.data.error, "invalid telegram signature");
    } finally {
      restoreEnv();
    }
  });

  it("rejects Telegram WebApp initData for the wrong user", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "123456789",
      telegramApprovalUserIds: "123456789"
    });
    try {
      const initData = signedTelegramInitData({ botToken, userId: 111 });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 403);
      assert.equal(auth.data.error, "telegram user is not authorized");
    } finally {
      restoreEnv();
    }
  });

  it("rejects stale Telegram WebApp auth_date values", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "123456789",
      telegramApprovalUserIds: "123456789"
    });
    try {
      const authDate = Math.floor(Date.now() / 1000) - 3600;
      const initData = signedTelegramInitData({ botToken, userId: 123456789, authDate });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 401);
      assert.equal(auth.data.error, "telegram auth expired");
    } finally {
      restoreEnv();
    }
  });

  it("does not create or notify workflow-start approvals by default", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "-100999",
      telegramThreadId: "77",
      baseUrl: "https://hub.example"
    });
    try {
      const created = await api("/api/capabilities/implement-change-gated/run", {
        method: "POST",
        body: { input: { workPrompt: "No noisy run-start DM", repo: "/tmp/runyard", targetBranch: "main", deploy: true } }
      });
      assert.equal(created.run.status, "queued");
      const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
      assert.equal(approval, undefined);
      assert.equal(calls.filter((call) => call.url.endsWith("/sendMessage")).length, 0);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("auto-queues legacy pending workflow-start approvals", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { name: "legacy" } }
    });
    updateRun(created.run.id, { status: "waiting_approval", current_step: "waiting for approval" });
    createApproval({
      runId: created.run.id,
      title: "Approve legacy workflow start",
      description: "Legacy workflow-start gate.",
      requestedBy: "test",
      payload: { kind: "run_start", approvalKind: "run_start", approvalScope: "workflow_start" }
    });

    assert.equal(autoQueueLegacyRunStartApprovals(), 1);
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "queued");
    assert.equal(detail.run.currentStep, "queued");
    const approval = (await api("/api/approvals")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval.status, "approved");
    assert.equal(approval.resolvedBy, "system:auto-queue");
  });

  it("sends structured private Telegram checkpoint approvals with a miniapp open button", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "-100999",
      telegramThreadId: "77",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "Checkpoint Telegram notification" } }
      });
      const approval = createApproval({
        runId: created.run.id,
        title: "Approve production checkpoint",
        description: "A workflow checkpoint needs an operator decision.",
        requestedBy: "workflow: hello",
        payload: {
          kind: "approval_checkpoint",
          approvalKind: "checkpoint",
          approvalScope: "workflow_checkpoint",
          capability: "hello",
          input: {
            requestedBy: "Operator <ops>",
            proposedAction: "Approve the deploy checkpoint after tests pass.",
            change: "Ship <b>approval</b> DM formatting & keep JSON out",
            repo: "/tmp/runyard",
            targetBranch: "main",
            deploy: true
          }
        }
      });
      await notifyTelegram(approval);

      const send = calls.find((call) => call.url.endsWith("/sendMessage"));
      assert.ok(send);
      assert.equal(send.body.chat_id, "12345");
      assert.equal(Object.hasOwn(send.body, "message_thread_id"), false);
      assert.equal(send.body.parse_mode, "HTML");
      assert.match(send.body.text, /<b>Thing being approved<\/b>/);
      assert.match(send.body.text, /<b>Proposed change<\/b>\n<pre>Ship &lt;b&gt;approval&lt;\/b&gt; DM formatting &amp; keep JSON out<\/pre>/);
      assert.match(send.body.text, /<b>Decision \/ action<\/b>\nApprove the deploy checkpoint after tests pass\./);
      assert.match(send.body.text, /<b>Workflow<\/b>\nHello \(Smithers proof\) \(hello\)/);
      assert.match(send.body.text, /<b>Originator:<\/b> Operator &lt;ops&gt;/);
      assert.match(send.body.text, /<b>Project \/ repo \/ path:<\/b> \/tmp\/runyard/);
      assert.match(send.body.text, /<b>Target branch:<\/b> main/);
      assert.match(send.body.text, /<b>Deploy:<\/b> yes/);
      assert.match(send.body.text, /<b>Run<\/b>\n<code>run_[a-f0-9]{20}<\/code> \(queued\)/);
      assert.match(send.body.text, /<b>Approval:<\/b> appr_[a-f0-9]{20}/);
      assert.doesNotMatch(send.body.text, /Approval link:/);
      assert.doesNotMatch(send.body.text, /"change"|"requestedBy"|\{|\}/);
      const buttons = send.body.reply_markup.inline_keyboard.flat();
      assert.ok(buttons.find((button) => button.text === "Open approval" && button.web_app?.url.includes("/app#approvals/")));
      assert.ok(buttons.find((button) => button.text === "Approve" && /^approval:approve:appr_[a-f0-9]{20}$/.test(button.callback_data)));
      assert.ok(buttons.find((button) => button.text === "Request changes" && /^approval:request_changes:appr_[a-f0-9]{20}$/.test(button.callback_data)));
      assert.ok(buttons.find((button) => button.text === "Reject" && /^approval:reject:appr_[a-f0-9]{20}$/.test(button.callback_data)));

      const approved = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-checkpoint-approve",
              data: `approval:approve:${approval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 21, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.data.approval.status, "approved");
      assert.equal(approved.data.approval.decision, "approved");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-checkpoint-approve");
      assert.ok(ack);
      assert.equal(ack.body.text, "Approved.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 21);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram approve callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: approveRun, approval: approveApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Approve from Telegram",
        deploy: false
      });
      const approved = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-approve",
              data: `approval:approve:${approveApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 11, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.data.approval.status, "approved");
      assert.equal(approved.data.approval.decision, "approved");
      assert.equal((await api(`/api/runs/${approveRun.run.id}`)).run.status, "queued");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-approve");
      assert.ok(ack);
      assert.equal(ack.body.text, "Approved.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 11);
      assert.ok(edit);
      assert.equal(String(edit.body.chat_id), "12345");
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram reject callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: rejectRun, approval: rejectApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Reject from Telegram",
        deploy: false
      });
      const rejected = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-reject",
              data: `reject:${rejectApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 12, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(rejected.status, 200);
      assert.equal(rejected.data.approval.status, "rejected");
      assert.equal(rejected.data.approval.decision, "rejected");
      assert.equal((await api(`/api/runs/${rejectRun.run.id}`)).run.status, "cancelled");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-reject");
      assert.ok(ack);
      assert.equal(ack.body.text, "Rejected.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 12);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram request-changes callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: changesRun, approval: changesApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Change this from Telegram",
        deploy: false
      });
      const changed = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-changes",
              data: `approval:request_changes:${changesApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 13, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.data.approval.status, "rejected");
      assert.equal(changed.data.approval.decision, "changes_requested");
      assert.equal(changed.data.approval.comment, "Changes requested from Telegram");
      const run = (await api(`/api/runs/${changesRun.run.id}`)).run;
      assert.equal(run.status, "cancelled");
      assert.equal(run.currentStep, "changes requested; run cancelled");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-changes");
      assert.ok(ack);
      assert.equal(ack.body.text, "Changes requested.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 13);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("rejects invalid Telegram callback data with a useful error", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramWebhookSecret: "telegram-test-secret"
    });
    try {
      const res = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: { callback_query: { id: "cb-invalid", data: "approval:maybe:appr_bad", message: { chat: { id: 12345 } } } }
        },
        null
      );
      assert.equal(res.status, 400);
      assert.equal(res.data.error, "invalid approval decision");
      assert.ok(calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-invalid"));
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("keeps approval API and detail deep links available", async () => {
    const checkpoint = await createCheckpointApproval("idea-to-product", { idea: "Deep link approval test", deploy: false });
    const created = checkpoint.created;
    const approval = (await api(`/api/approvals/${checkpoint.approval.id}`)).approval;
    assert.equal(approval.deepLink, `/app#approvals/${approval.id}`);
    assert.equal(approval.deepLinkRun, `/app#runs/${created.run.id}`);
    assert.equal(approval.context.run.id, created.run.id);
    assert.equal(approval.context.deploy, false);
    assert.ok(approval.payloadSummary.input);

    const detail = await api(`/api/approvals/${approval.id}`);
    assert.equal(detail.approval.deepLink, `/app#approvals/${approval.id}`);
    assert.equal(detail.approval.context.workflow.slug, "idea-to-product");
    assert.equal(detail.approval.context.requestedBy, "token: bootstrap-admin");
    const appPage = await fetch(`${baseUrl}/app#approvals/${approval.id}`);
    assert.equal(appPage.status, 200);
  });

  it("resolves web/API request-changes decisions with a comment", async () => {
    const { created, approval } = await createCheckpointApproval("implement-change-gated", {
      workPrompt: "Needs more detail",
      deploy: false
    });
    const resolved = await api(`/api/approvals/${approval.id}/request-changes`, {
      method: "POST",
      body: { comment: "Please include the target branch and rollout plan." }
    });
    assert.equal(resolved.approval.status, "rejected");
    assert.equal(resolved.approval.decision, "changes_requested");
    assert.equal(resolved.approval.comment, "Please include the target branch and rollout plan.");
    const run = (await api(`/api/runs/${created.run.id}`)).run;
    assert.equal(run.status, "cancelled");
    assert.equal(run.currentStep, "changes requested; run cancelled");
  });

  it("has a readiness probe and run pagination metadata", async () => {
    assert.equal((await raw("/readyz", {}, null)).status, 200);
    const runs = await api("/api/runs?limit=5");
    assert.equal(typeof runs.total, "number");
    assert.equal(runs.limit, 5);
  });

  it("records an audit trail for token creation", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "audited", scopes: ["api"] } });
    const audit = await api("/api/audit");
    assert.ok(audit.audit.find((entry) => entry.action === "token.created" && entry.target === created.token.id));
  });

  it("blocks runners from touching runs they do not own", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "owner" } } });
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "runner-only", scopes: ["runner"] } })).token.token;
    // Has runner scope, but does not own this (unassigned) run -> 403.
    const start = await raw(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} }, runnerToken);
    assert.equal(start.status, 403);
  });

  it("does not let a runner token hijack another runner's id", async () => {
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "rt", scopes: ["runner"] } })).token.token;
    const mine = await raw("/api/runners/register", { method: "POST", body: { name: "mine", tags: ["smithers", "node"] } }, runnerToken);
    const myId = mine.data.runner.id;
    // A different token (admin) tries to register using my runner id -> must NOT overwrite mine.
    const other = await api("/api/runners/register", { method: "POST", body: { id: myId, name: "hijack", tags: ["smithers", "node"] } });
    assert.notEqual(other.runner.id, myId);
  });
});

describe("Authenticated workflow endpoints", () => {
  const endpointSecret = "shub_test_feedback_endpoint";

  it("lists configured endpoints for admins without exposing secrets", async () => {
    const listed = await api("/api/workflow-endpoints");
    const endpoint = listed.endpoints.find((entry) => entry.slug === "runyard-mobile-feedback");
    assert.ok(endpoint, "seeded feedback endpoint should be discoverable to admins");
    assert.equal(endpoint.capabilitySlug, "improve-no-deploy");
    assert.equal(endpoint.repo, "smithers-hub");
    assert.equal(endpoint.project, "runyard");
    assert.equal(endpoint.secretConfigured, true);
    assert.equal(JSON.stringify(endpoint).includes(endpointSecret), false);
    assert.equal(Object.hasOwn(endpoint, "secretHash"), false);
  });

  it("rejects unauthorized feedback endpoint requests", async () => {
    const missing = await raw(
      "/api/workflow-endpoints/runyard-mobile-feedback",
      { method: "POST", body: { feedback: "missing auth" } },
      null
    );
    assert.equal(missing.status, 401);

    const invalid = await raw(
      "/api/workflow-endpoints/runyard-mobile-feedback",
      { method: "POST", body: { feedback: "bad auth" } },
      "shub_wrong_feedback_secret"
    );
    assert.equal(invalid.status, 401);
  });

  it("queues authorized feedback as a constrained improve-no-deploy run and records audit metadata", async () => {
    const feedback = "Please make the approval screen easier to scan on mobile.";
    const created = await raw(
      "/api/workflow-endpoints/runyard-mobile-feedback",
      {
        method: "POST",
        body: {
          feedback,
          app: "runyard-mobile",
          user: "fran",
          session: "sess-auth-endpoint",
          url: "https://app.example/feedback",
          route: "/approvals",
          severity: "medium",
          workflowSlug: "hello",
          capabilitySlug: "hello",
          repo: "other-repo",
          project: "other-project",
          repoDir: "/tmp/evil",
          runnerId: "runner_evil",
          deploy: true,
          targetBranch: "prod"
        }
      },
      endpointSecret
    );
    assert.equal(created.status, 202);
    assert.equal(created.data.deduped, false);
    assert.equal(created.data.run.capabilitySlug, "improve-no-deploy");
    assert.match(created.data.payloadHash, /^sha256:[a-f0-9]{64}$/);

    const detail = await api(`/api/runs/${created.data.run.id}`);
    assert.equal(detail.run.capabilitySlug, "improve-no-deploy");
    assert.equal(detail.run.status, "queued");
    assert.equal(detail.run.input.project, "runyard");
    assert.equal(detail.run.input.repo, "smithers-hub");
    assert.equal(detail.run.input.repoDir, undefined);
    assert.equal(detail.run.input.deploy, undefined);
    assert.equal(detail.run.input.targetBranch, undefined);
    assert.equal(detail.run.input.runnerId, undefined);
    assert.equal(detail.run.input.untrustedFeedback.text, feedback);
    assert.equal(detail.run.input.untrustedFeedback.app, "runyard-mobile");
    assert.equal(detail.run.input.untrustedFeedback.user, "fran");
    assert.equal(detail.run.input.untrustedFeedback.session, "sess-auth-endpoint");
    assert.match(detail.run.input.context, /untrusted user\/app data/i);
    assert.equal(detail.run.origin.type, "workflow-endpoint");
    assert.equal(detail.run.origin.endpointSlug, "runyard-mobile-feedback");

    const events = await api(`/api/runs/${created.data.run.id}/events`);
    assert.ok(events.events.find((event) => event.type === "workflow_endpoint.queued"));

    const audit = await api("/api/audit?limit=50");
    const entry = audit.audit.find((item) => item.action === "workflow_endpoint.queued" && item.target === created.data.run.id);
    assert.ok(entry, "workflow endpoint enqueue should be audited");
    assert.equal(entry.detail.endpointSlug, "runyard-mobile-feedback");
    assert.equal(entry.detail.runId, created.data.run.id);
    assert.equal(entry.detail.payloadHash, created.data.payloadHash);
    assert.equal(entry.detail.source.app, "runyard-mobile");
    assert.equal(entry.detail.source.user, "fran");
    assert.equal(entry.detail.source.session, "sess-auth-endpoint");
    const auditJson = JSON.stringify(entry);
    assert.equal(auditJson.includes(endpointSecret), false);
    assert.equal(auditJson.includes(feedback), false);
  });

  it("dedupes repeated feedback payloads within the endpoint window", async () => {
    const body = {
      feedback: "Repeated feedback payload for dedupe coverage.",
      app: "runyard-mobile",
      session: "sess-dedupe"
    };
    const first = await raw("/api/workflow-endpoints/runyard-mobile-feedback", { method: "POST", body }, endpointSecret);
    assert.equal(first.status, 202);
    assert.equal(first.data.deduped, false);

    const second = await raw("/api/workflow-endpoints/runyard-mobile-feedback", { method: "POST", body }, endpointSecret);
    assert.equal(second.status, 202);
    assert.equal(second.data.deduped, true);
    assert.equal(second.data.run.id, first.data.run.id);

    const audit = await api("/api/audit?limit=50");
    assert.ok(audit.audit.find((entry) => entry.action === "workflow_endpoint.deduped" && entry.target === first.data.run.id));
  });

  it("enforces endpoint payload limits and per-endpoint rate limits", async () => {
    const tooLarge = await raw(
      "/api/workflow-endpoints/runyard-mobile-feedback",
      { method: "POST", body: { feedback: "x".repeat(33 * 1024), app: "runyard-mobile" } },
      endpointSecret
    );
    assert.equal(tooLarge.status, 413);

    const rateSecret = "shub_test_rate_endpoint";
    await api("/api/workflow-endpoints", {
      method: "POST",
      body: {
        slug: "rate-limit-feedback",
        name: "Rate limit feedback",
        secret: rateSecret,
        capabilitySlug: "improve-no-deploy",
        project: "runyard",
        repo: "smithers-hub",
        maxPayloadBytes: 4096,
        rateLimitCount: 1,
        rateLimitWindowMs: 60_000,
        dedupeWindowMs: 0,
        config: { target: "Rate limit feedback", maxImprovements: 1 }
      }
    });

    const first = await raw(
      "/api/workflow-endpoints/rate-limit-feedback",
      { method: "POST", body: { feedback: "first rate-limited payload" } },
      rateSecret
    );
    assert.equal(first.status, 202);

    const second = await raw(
      "/api/workflow-endpoints/rate-limit-feedback",
      { method: "POST", body: { feedback: "second rate-limited payload" } },
      rateSecret
    );
    assert.equal(second.status, 429);
  });

  it("seeds improve-no-deploy as a recommendation-only workflow without deploy behavior", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((entry) => entry.slug === "improve-no-deploy");
    assert.ok(cap, "improve-no-deploy capability should be seeded");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/improve-no-deploy.tsx");
    assert.equal(cap.approvalPolicy.required, false);
    assert.equal(cap.inputSchema.properties.deploy, undefined);
    assert.equal(cap.inputSchema.properties.untrustedFeedback.type, "object");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers"]);
    assert.ok(cap.requiredSkills.includes("product-review"));

    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "improve-no-deploy.tsx");
    assert.ok(existsSync(tpl), "bundled improve-no-deploy workflow should exist");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /UNTRUSTED FEEDBACK DATA/);
    assert.match(src, /id="review"/);
    assert.match(src, /id="patch-suggestions"/);
    assert.match(src, /id="report"/);
    assert.doesNotMatch(src, /id="(?:implement|test|commit|push|deploy)"/);
    assert.doesNotMatch(src, /git\s+push|push",\s*"origin"|systemctl|GATED_/);
  });
});

describe("Failure / cancellation diagnostics", () => {
  it("attaches a structured diagnostics payload to failed runs", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "diagnostic failure" } }
    });
    const runId = created.run.id;
    addRunEvent(runId, "workflow.step", "build started", { step: "build" });
    addRunEvent(runId, "stderr", "fatal: pnpm install exited 1", {});
    addRunEvent(runId, "node.failed", "build node failed", { node: "build", step: "build" });
    transitionRun(runId, "failed", { error: "pnpm install exited 1", current_step: "build", completed_at: new Date().toISOString() });

    const detail = await api(`/api/runs/${runId}`);
    assert.ok(detail.diagnostics, "diagnostics object should be present for failed runs");
    assert.equal(detail.diagnostics.status, "failed");
    assert.match(detail.diagnostics.headline, /pnpm install/);
    assert.equal(detail.diagnostics.failedStep, "build");
    assert.match(detail.diagnostics.failureType, /node\.failed|run\.failed/);
    assert.ok(detail.diagnostics.timeline.length, "focused timeline should include surrounding events");
    assert.ok(detail.diagnostics.logExcerpts.length, "log excerpts should be returned");
    assert.equal(detail.run.reasonHint, "pnpm install exited 1");
  });

  it("redacts secret-looking values from log excerpts and the logs endpoint", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "redaction" } }
    });
    const runId = created.run.id;
    addRunEvent(runId, "stderr", "request failed: authorization=Bearer shub_AAAABBBBCCCCDDDDEEEE token=shub_secretvalue123", {});
    addRunEvent(runId, "run.failed", "leak attempt", {});
    transitionRun(runId, "failed", { error: "leak attempt", completed_at: new Date().toISOString() });

    const detail = await api(`/api/runs/${runId}`);
    const log = detail.diagnostics.logExcerpts.find((entry) => entry.type === "stderr");
    assert.ok(log, "stderr entry should be retained in excerpts");
    assert.doesNotMatch(log.message, /shub_AAAABBBBCCCCDDDDEEEE/);
    assert.doesNotMatch(log.message, /shub_secretvalue123/);
    assert.match(log.message, /\[redacted\]/);

    const logsResponse = await fetch(`${baseUrl}/api/runs/${runId}/logs`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const text = await logsResponse.text();
    assert.doesNotMatch(text, /shub_AAAABBBBCCCCDDDDEEEE/);
  });

  it("surfaces approval comments as the cancellation reason when an approval rejected the run", async () => {
    const { created, approval } = await createCheckpointApproval("implement-change-gated", {
      workPrompt: "diagnostics for changes_requested",
      deploy: false
    });
    await api(`/api/approvals/${approval.id}/request-changes`, {
      method: "POST",
      body: { comment: "Please add the rollout plan before deploying." }
    });

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "cancelled");
    assert.ok(detail.diagnostics);
    assert.equal(detail.diagnostics.status, "cancelled");
    assert.ok(detail.diagnostics.approval, "approval summary should be linked from diagnostics");
    assert.equal(detail.diagnostics.approval.decision, "changes_requested");
    assert.match(detail.diagnostics.approval.comment, /rollout plan/);
    assert.match(detail.diagnostics.headline, /rollout plan/);
    assert.ok(detail.diagnostics.timeline.some((event) => /approval\.changes_requested|approval\.rejected/.test(event.type)));
  });

  it("returns waiting_approval diagnostics so paused runs show why up-front", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "pause" } }
    });
    updateRun(created.run.id, { status: "waiting_approval", current_step: "needs approval" });
    createApproval({
      runId: created.run.id,
      title: "Approve diagnostics pause",
      description: "Waiting on operator decision.",
      requestedBy: "workflow",
      payload: { kind: "checkpoint", approvalKind: "checkpoint", approvalScope: "workflow_checkpoint", capability: "hello", input: {} }
    });

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.ok(detail.diagnostics, "waiting_approval runs should still expose diagnostics");
    assert.equal(detail.diagnostics.status, "waiting_approval");
    assert.match(detail.diagnostics.headline, /Approve diagnostics pause|approval/i);
    assert.ok(detail.diagnostics.approval);
    assert.equal(detail.diagnostics.approval.status, "pending");
  });

  it("does not attach diagnostics to runs that succeeded", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "happy path" } }
    });
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "diagnostics-success", hostname: "diag", tags: ["smithers", "node"] }
    });
    await api(`/api/runners/${runner.runner.id}/next-run`);
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });

    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "succeeded");
    assert.equal(detail.diagnostics, null);
    assert.equal(detail.run.reasonHint, "");
  });

  it("exposes diagnostics through the dedicated endpoint and includes diagnostic artifacts", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "diagnostic artifacts" } }
    });
    const runId = created.run.id;
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "diagnostics-runner", hostname: "diag2", tags: ["smithers", "node"] }
    });
    await api(`/api/runners/${runner.runner.id}/next-run`);
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${runId}/artifacts`, {
      method: "POST",
      body: { name: "stderr.log", mimeType: "text/plain", contentBase64: Buffer.from("boom").toString("base64") }
    });
    await api(`/api/runs/${runId}/fail`, { method: "POST", body: { error: "explosion in build" } });

    const direct = await api(`/api/runs/${runId}/diagnostics`);
    assert.ok(direct.diagnostics);
    assert.equal(direct.diagnostics.status, "failed");
    assert.match(direct.diagnostics.headline, /explosion/);
    assert.ok(direct.diagnostics.artifacts.length, "diagnostic artifacts should be linked");
    assert.equal(direct.diagnostics.artifacts[0].name, "stderr.log");
  });

  it("surfaces a short reasonHint on the runs list for failed runs", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "list reason hint" } }
    });
    transitionRun(created.run.id, "failed", { error: "compile error: missing semicolon", completed_at: new Date().toISOString() });

    const list = await api("/api/runs?limit=200");
    const row = list.runs.find((entry) => entry.id === created.run.id);
    assert.ok(row, "failed run should still appear in list");
    assert.equal(row.status, "failed");
    assert.match(row.reasonHint, /compile error/);
  });
});

describe("Smart Contract Audit capability", () => {
  const smokeFixture = path.join(process.cwd(), "tests", "fixtures", "smart-contract-audit", "contracts");

  it("is seeded as a real Smithers workflow capability", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "smart-contract-audit");
    assert.ok(cap, "smart-contract-audit capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/smart-contract-audit.tsx");
    assert.ok(cap.inputSchema.required.includes("target"));
    assert.equal(cap.enabled, true);
  });

  it("is runnable through the API (creates a queued run)", async () => {
    assert.ok(existsSync(path.join(smokeFixture, "TinyVault.sol")), "phase-0 smoke fixture should exist");
    const created = await api("/api/capabilities/smart-contract-audit/run", {
      method: "POST",
      body: {
        input: {
          target: smokeFixture,
          scope: "Phase-0 smoke baseline",
          maxAgents: 1
        },
        origin: { type: "phase-0-smoke-test", label: "Phase 0 smoke baseline" }
      }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "smart-contract-audit");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    assert.equal(created.supervising.wrappedCapability, "smart-contract-audit");
    assert.equal(created.run.supervision.wrappedCapability, "smart-contract-audit");
    assert.equal(created.run.input.target, smokeFixture);
    assert.equal(created.run.input.maxAgents, 1);
    assert.equal(created.run.input.wrappedCapability, undefined);
  });

  it("ships the workflow template in the runner bundle directory", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "smart-contract-audit.tsx");
    assert.ok(existsSync(tpl), "bundled workflow template should exist");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /prepare-sandbox\.sh/);
    assert.match(src, /build-bundles\.sh/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Gated implement-change capability", () => {
  it("is seeded as an approval-gated Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "implement-change-gated");
    assert.ok(cap, "implement-change-gated capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/implement-change-gated.tsx");
    assert.ok(cap.inputSchema.required.includes("workPrompt"));
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("queues immediately and relies on in-workflow approvals", async () => {
    const created = await api("/api/capabilities/implement-change-gated/run", {
      method: "POST",
      body: { input: { workPrompt: "noop", deploy: false } }
    });
    assert.equal(created.run.status, "queued");
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the gated workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "implement-change-gated.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /pnpm/);
    assert.match(src, /git.*push.*origin|push", "origin"/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Idea to Product capability", () => {
  it("is seeded as an approval-gated Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "idea-to-product");
    assert.ok(cap, "idea-to-product capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/idea-to-product.tsx");
    assert.ok(cap.inputSchema.required.includes("idea"));
    assert.equal(cap.inputSchema.properties.publicAccess.type, "boolean");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers", "vps"]);
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("is wrapped in a supervising run-smithers run by default", async () => {
    const created = await api("/api/capabilities/idea-to-product/run", {
      method: "POST",
      body: { input: { idea: "A tiny dashboard for tracking launch chores", deploy: false } }
    });
    assert.equal(created.run.status, "queued");
    // The Hub applies the default supervision envelope, but the API presents
    // the user-requested workflow and keeps the wrapper as metadata.
    assert.equal(created.run.capabilitySlug, "idea-to-product");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    assert.equal(created.supervising.wrappedCapability, "idea-to-product");
    assert.equal(created.run.supervision.wrappedCapability, "idea-to-product");
    assert.equal(created.run.input.idea, "A tiny dashboard for tracking launch chores");
    assert.equal(created.run.input.wrappedCapability, undefined);
    assert.equal(created.run.input.wrappedInput, undefined);
    // The internal bypass token must never be exposed to API callers.
    assert.equal(created.run.input.__supervisionToken, undefined);
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the idea-to-product workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "idea-to-product.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /configured static host|STATIC_SITE_HOST/);
    assert.match(src, /publicAccess/);
    assert.match(src, /Set-Cookie/);
    assert.match(src, /pnpm build/);
    assert.match(src, /ClaudeCodeAgent/);
  });

  it("encodes the narrow-output, copywriter, and live-app guards in the workflow template", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "idea-to-product.tsx");
    const src = readFileSync(tpl, "utf8");
    // Strategist narrow-output contract: echo the ask verbatim and emit
    // explicit inScope / outOfScope / locale.
    assert.match(src, /originalAsk/);
    assert.match(src, /inScope/);
    assert.match(src, /outOfScope/);
    assert.match(src, /BCP-47/);
    // Builder copy rule: one language per page.
    assert.ok(src.includes("one language per page"), "builder/copywriter prompt must contain the 'one language per page' rule");
    // Copywriter step exists as a Task between build and verify.
    assert.match(src, /id="copy"/);
    assert.match(src, /copywriter/);
    // Personality copy uses neutral meaning → neutral translation → independent rewrites.
    assert.ok(src.includes("neutral meaning"), "copywriter prompt must contain the 'neutral meaning' translation pattern");
    // Live-app replacement guard.
    assert.ok(
      src.includes("already hosts a live app"),
      "live-app guard message 'already hosts a live app' must be present"
    );
    assert.match(src, /replaceLive/);
    assert.match(src, /--replace-live/);
    // Mobile-first acceptance checks in verify.
    assert.match(src, /360px/);
    assert.match(src, /tap-target>=44px|tap target/i);
    assert.match(src, /body-text>=16px|>=16px/);
    assert.match(src, /CTA-above-fold|above the fold/i);
    assert.match(src, /no-horizontal-scroll|horizontal scroll/i);
    // Summary lines surfaced before deploy URL.
    assert.match(src, /Locale: /);
    assert.match(src, /In scope: /);
    assert.match(src, /Out of scope: /);
  });

  it("surfaces locale and replaceLive on the idea-to-product capability schema", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "idea-to-product");
    assert.ok(cap, "idea-to-product capability should be in the catalog");
    assert.equal(cap.inputSchema.properties.locale.type, "string");
    assert.equal(cap.inputSchema.properties.replaceLive.type, "boolean");
    assert.ok(cap.outputSchema.properties.liveAppGuard, "liveAppGuard output should be advertised");
    assert.ok(cap.outputSchema.properties.copy, "copywriter output should be advertised");
  });
});

describe("App Skinner capability", () => {
  it("is seeded as an approval-checkpoint Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "app-skinner");
    assert.ok(cap, "app-skinner capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/app-skinner.tsx");
    assert.ok(cap.inputSchema.required.includes("appIdea"));
    assert.equal(cap.inputSchema.properties.skinCount.type, "number");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers", "vps"]);
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("queues immediately and relies on the skin approval checkpoint", async () => {
    const created = await api("/api/capabilities/app-skinner/run", {
      method: "POST",
      body: { input: { appIdea: "A/B cat compass miniapp", skinCount: 3 } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "app-skinner");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    assert.equal(created.supervising.wrappedCapability, "app-skinner");
    assert.equal(created.run.supervision.wrappedCapability, "app-skinner");
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the app-skinner workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "app-skinner.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /Approve app skin direction/);
    assert.match(src, /visual skins/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Catalog referential integrity", () => {
  it("resolves every capability and agent catalog reference", async () => {
    const { capabilities } = await api("/api/capabilities");
    const { agents } = await api("/api/agents");
    const { skills } = await api("/api/skills");
    const agentSlugs = new Set(agents.map((agent) => agent.slug));
    const skillSlugs = new Set(skills.map((skill) => skill.slug));

    for (const cap of capabilities) {
      for (const slug of cap.requiredAgents || []) {
        assert.ok(agentSlugs.has(slug), `${cap.slug} references missing agent card: ${slug}`);
      }
      for (const slug of cap.requiredSkills || []) {
        assert.ok(skillSlugs.has(slug), `${cap.slug} references missing skill card: ${slug}`);
      }
      if (cap.workflow?.entry) {
        const bundledPath = cap.workflow.entry.replace(/^\.smithers\//, "workflow-templates/");
        assert.ok(existsSync(path.join(process.cwd(), bundledPath)), `${cap.slug} references missing workflow template: ${bundledPath}`);
      }
    }

    for (const agent of agents) {
      for (const slug of agent.skillSlugs || []) {
        assert.ok(skillSlugs.has(slug), `${agent.slug} references missing skill card: ${slug}`);
      }
    }
  });
});

describe("Run Knowledge Builder capability", () => {
  it("is seeded as a recommendation-only Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "run-knowledge-builder");
    assert.ok(cap, "run-knowledge-builder capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/run-knowledge-builder.tsx");
    assert.equal(cap.category, "Knowledge");
    assert.equal(cap.inputSchema.properties.capabilitySlug.type, "string");
    assert.equal(cap.inputSchema.properties.status.type, "string");
    assert.equal(cap.inputSchema.properties.lookbackHours.type, "number");
    assert.equal(cap.inputSchema.properties.count.type, "number");
    assert.equal(cap.inputSchema.properties.focusArea.type, "string");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers"]);
    assert.ok(cap.requiredSkills.includes("run-knowledge-loop"));
    assert.ok(cap.requiredAgents.includes("run-knowledge-analyst"));
    assert.equal(cap.approvalPolicy.required, false);
  });

  it("queues through the API without creating a start approval", async () => {
    const created = await api("/api/capabilities/run-knowledge-builder/run", {
      method: "POST",
      body: { input: { capabilitySlug: "hello", status: "failed,cancelled", count: 5, focusArea: "failure patterns" } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "run-knowledge-builder");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    assert.equal(created.supervising.wrappedCapability, "run-knowledge-builder");
    assert.equal(created.run.supervision.wrappedCapability, "run-knowledge-builder");
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the workflow template and report artifact contract", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "run-knowledge-builder.tsx");
    assert.ok(existsSync(tpl), "bundled workflow template should exist");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /recurringFailureModes/);
    assert.match(src, /suggestedSkillUpdates/);
    assert.match(src, /suggestedAgentInstructionUpdates/);
    assert.match(src, /suggestedWorkflowTemplateImprovements/);
    assert.match(src, /recommendedNextActions/);
    assert.match(src, /\/api\/runs/);
    assert.match(src, /\/diagnostics/);
    assert.match(src, /redactText/);
    assert.match(src, /run-knowledge-report\.md/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Improve capability", () => {
  it("is seeded as an approval-gated PM-led Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "improve");
    assert.ok(cap, "improve capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/improve.tsx");
    assert.ok(cap.inputSchema.required.includes("target"));
    assert.equal(cap.inputSchema.properties.repoDir.type, "string");
    assert.match(cap.inputSchema.properties.repoDir.description, /runner-local git repo path/);
    assert.equal(cap.inputSchema.properties.repo.type, "string");
    assert.equal(cap.inputSchema.properties.project.type, "string");
    assert.ok(cap.requiredAgents.includes("product-manager"), "improve must require the product-manager agent");
    assert.ok(cap.requiredAgents.includes("implementation-agent"), "improve must dispatch the implementation agent");
    assert.ok(cap.requiredSkills.includes("product-review"));
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("is wrapped in a supervising run-smithers run by default", async () => {
    const created = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "Run log usability", context: "Logs are too noisy" } }
    });
    assert.equal(created.run.status, "queued");
    // Default supervision envelope: improve runs behind run-smithers, but the
    // API keeps the requested workflow/input visible.
    assert.equal(created.run.capabilitySlug, "improve");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    assert.equal(created.supervising.wrappedCapability, "improve");
    assert.equal(created.run.supervision.wrappedCapability, "improve");
    assert.equal(created.run.input.target, "Run log usability");
    assert.equal(created.run.input.context, "Logs are too noisy");
    assert.equal(created.run.input.wrappedCapability, undefined);
    assert.equal(created.run.input.wrappedInput, undefined);
    assert.equal(created.run.input.__supervisionToken, undefined);
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("seeds the product-manager agent and product-review skill", async () => {
    const { agents } = await api("/api/agents");
    const { skills } = await api("/api/skills");
    const pm = agents.find((agent) => agent.slug === "product-manager");
    assert.ok(pm, "product-manager agent should be seeded");
    assert.match(pm.name, /Product Manager/);
    assert.ok(skills.find((skill) => skill.slug === "product-review"), "product-review skill should be seeded");
  });

  it("ships the improve workflow template with PM-then-builder structure", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "improve.tsx");
    assert.ok(existsSync(tpl), "bundled workflow template should exist");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /Product Manager/);
    assert.match(src, /id="review"/);
    assert.match(src, /id="implement"/);
    assert.match(src, /id="test"/);
    assert.match(src, /id="commit"/);
    assert.match(src, /id="push"/);
    assert.match(src, /id="deploy"/);
    assert.match(src, /improvements/);
    assert.match(src, /acceptanceCheck/);
    assert.match(src, /resolveImproveRepo\(ctx\.input/);
    assert.match(src, /cwd: repoDir/);
    assert.match(src, /HARD SCOPE CONTRACT/);
    assert.match(src, /docs\/runbook target must not become landing-page work/);
    assert.match(src, /mobile\/narrow-viewport acceptance checks/);
    assert.doesNotMatch(src, /const REPO =/);
    assert.match(src, /ClaudeCodeAgent/);
  });

  it("records origin metadata on improve runs", async () => {
    const created = await api("/api/capabilities/improve/run", {
      method: "POST",
      headers: { "x-smithers-origin": "telegram: improve test" },
      body: { input: { target: "Improve run log" } }
    });
    assert.equal(created.run.originLabel, "telegram: improve test");
  });
});

describe("Run log usability", () => {
  it("returns a structured log summary alongside run detail", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "structured log summary" } }
    });
    const runId = created.run.id;
    addRunEvent(runId, "run.started", "Run started", {});
    addRunEvent(runId, "workflow.step", "review", { step: "review" });
    addRunEvent(runId, "node.started", "PM review", { node: "review" });
    addRunEvent(runId, "heartbeat", "still alive", {});
    addRunEvent(runId, "heartbeat", "still alive", {});
    addRunEvent(runId, "stderr", "warning: deprecated flag", {});
    addRunEvent(runId, "node.finished", "PM review done", { node: "review" });
    addRunEvent(runId, "node.failed", "build node failed", { node: "build" });
    addRunEvent(runId, "run.failed", "build node failed", {});

    const detail = await api(`/api/runs/${runId}`);
    assert.ok(detail.logSummary, "logSummary should be returned with run detail");
    assert.ok(detail.logSummary.totals.events >= 9);
    assert.ok(detail.logSummary.totals.errors >= 1, "node.failed / run.failed should count as errors");
    const categoryKeys = detail.logSummary.categories.map((entry) => entry.key);
    assert.ok(categoryKeys.includes("run"));
    assert.ok(categoryKeys.includes("node"));
    assert.ok(categoryKeys.includes("noise"), "heartbeats should be categorised as noise");
    assert.ok(detail.logSummary.defaultCollapsed.includes("noise"));
    assert.ok(detail.logSummary.highlights.length, "highlights should include the focus events");
    assert.ok(detail.logSummary.highlights.every((entry) => entry.category !== "noise"), "noise should not appear in highlights");

    const summaryDirect = await api(`/api/runs/${runId}/log-summary`);
    assert.equal(summaryDirect.run.id, runId);
    assert.equal(summaryDirect.logSummary.totals.events, detail.logSummary.totals.events);
  });

  it("redacts secret-looking strings in highlight messages", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "log redaction" } }
    });
    addRunEvent(created.run.id, "run.failed", "auth failed authorization=Bearer shub_AAABBBCCCDDDEEE token=shub_secretvalue", {});
    const summary = await api(`/api/runs/${created.run.id}/log-summary`);
    const entry = summary.logSummary.highlights.find((item) => item.type === "run.failed");
    assert.ok(entry, "run.failed should be highlighted");
    assert.doesNotMatch(entry.message, /shub_AAABBBCCCDDDEEE/);
    assert.doesNotMatch(entry.message, /shub_secretvalue/);
    assert.match(entry.message, /\[redacted\]/);
  });

  it("exposes the structured log summary helper in app.js for the console", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    assert.match(code, /renderRunLog/);
    assert.match(code, /bindRunLogFilters/);
    assert.match(code, /run-log-highlights/);
    assert.match(code, /\/log-summary/);
  });

  it("makes run inputs and outputs the first-class detail section", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    assert.match(code, /Inputs &amp; outputs/);
    assert.match(code, /renderRunInputsOutputs/);
    assert.match(code, /renderPayloadSummaryList/);
    assert.match(code, /See raw JSON/);
    assert.match(code, /data-run-section="io"/);
    assert.match(code, /inputs\/outputs · log · artifacts · context/);
    assert.doesNotMatch(code, /Raw payload/);

    const styles = await raw("/public/styles.css");
    assert.equal(styles.status, 200);
    assert.match(styles.data, /run-io-section/);
    assert.match(styles.data, /run-io-grid/);
    assert.match(styles.data, /run-io-summary-list/);
    assert.match(styles.data, /run-io-raw/);
    assert.match(styles.data, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it("keeps supervised child attempts out of the default top-level runs view", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    assert.match(code, /isSupervisedChildRun/);
    assert.match(code, /topLevelRuns/);
    assert.match(code, /supervisedChildRunsNotice/);
    assert.match(code, /run-smithers wrapper/);
    assert.match(code, /supervised child attempt/);

    const styles = await raw("/public/styles.css");
    assert.equal(styles.status, 200);
    assert.match(styles.data, /supervised-child-summary/);
  });
});

// --- Runner pool & queue visibility -----------------------------------------
// Smithers Hub supports a multi-slot runner pool (typically 4 on a dedicated
// VPS host) while keeping a single centralized queue on the Hub. These tests
// pin the contract: capacity is honoured, slots are released on terminal
// transitions, queued runs carry a position, and the UI surfaces both.
describe("Runner pool capacity & queue visibility", () => {
  it("registers a runner with a capacity and exposes pool stats", async () => {
    const reg = await api("/api/runners/register", {
      method: "POST",
      body: { name: "pool-host", hostname: "pool-host", tags: ["smithers", "node"], capacity: 4 }
    });
    assert.equal(reg.runner.capacity, 4);
    assert.equal(reg.runner.activeRuns, 0);
    assert.equal(reg.runner.availableSlots, 4);

    const list = await api("/api/runners");
    assert.ok(list.pool, "runner list should include pool stats");
    assert.ok(list.pool.totalCapacity >= 4, "pool total capacity should include the new runner");
    assert.ok(typeof list.pool.queued === "number");
  });

  it("preserves single-slot behavior when no capacity is provided", async () => {
    const reg = await api("/api/runners/register", {
      method: "POST",
      body: { name: "legacy-runner", hostname: "legacy", tags: ["smithers", "node"] }
    });
    assert.equal(reg.runner.capacity, 1);
    assert.equal(reg.runner.availableSlots, 1);
  });

  it("claims multiple runs in parallel up to the runner's capacity", async () => {
    const reg = await api("/api/runners/register", {
      method: "POST",
      body: { name: "fleet-runner", hostname: "fleet", tags: ["smithers", "node"], capacity: 3 }
    });
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: `capacity-${i}` } }
      });
      runs.push(created.run.id);
    }
    const claims = [];
    for (let i = 0; i < 4; i += 1) {
      claims.push(await api(`/api/runners/${reg.runner.id}/next-run`));
    }
    const claimed = claims.filter((c) => c?.run).map((c) => c.run.id);
    // First three slots get filled; the fourth claim is blocked by capacity.
    assert.equal(claimed.length, 3);
    assert.equal(claims[3].run, undefined);

    // The runner record now reflects the saturated pool.
    const runners = (await api("/api/runners")).runners;
    const updated = runners.find((r) => r.id === reg.runner.id);
    assert.equal(updated.capacity, 3);
    assert.equal(updated.activeRuns, 3);
    assert.equal(updated.availableSlots, 0);
  });

  it("releases a runner slot when a claimed run reaches a terminal state", async () => {
    const reg = await api("/api/runners/register", {
      method: "POST",
      body: { name: "release-runner", hostname: "release", tags: ["smithers", "node"], capacity: 2 }
    });
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "release a slot" } }
    });
    const claim = await api(`/api/runners/${reg.runner.id}/next-run`);
    assert.equal(claim.run.id, created.run.id);
    let runners = (await api("/api/runners")).runners;
    let updated = runners.find((r) => r.id === reg.runner.id);
    assert.equal(updated.activeRuns, 1);

    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });

    runners = (await api("/api/runners")).runners;
    updated = runners.find((r) => r.id === reg.runner.id);
    assert.equal(updated.activeRuns, 0, "terminal transition must release the slot");
    assert.equal(updated.availableSlots, 2);
  });

  it("updates capacity through heartbeats so a runner restart with a new size takes effect", async () => {
    const reg = await api("/api/runners/register", {
      method: "POST",
      body: { name: "rescale-runner", hostname: "rescale", tags: ["smithers", "node"], capacity: 1 }
    });
    assert.equal(reg.runner.capacity, 1);
    const beat = await api(`/api/runners/${reg.runner.id}/heartbeat`, {
      method: "POST",
      body: { tags: ["smithers", "node"], capacity: 4, activeRuns: 0 }
    });
    assert.equal(beat.runner.capacity, 4);
    assert.equal(beat.runner.availableSlots, 4);
  });

  it("surfaces a queue position on queued runs", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "queue position" } }
    });
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "queued");
    assert.ok(detail.run.queue, "queued run detail should include a queue payload");
    assert.ok(detail.run.queue.position >= 1);
    assert.ok(detail.run.queue.total >= 1);

    const list = await api("/api/runs?status=queued&limit=200");
    const row = list.runs.find((r) => r.id === created.run.id);
    assert.ok(row.queue, "queued run row should include queue payload");
    assert.ok(typeof list.pool.queued === "number");
  });

  it("includes queue + capacity stats in the dashboard payload", async () => {
    const dash = await api("/api/dashboard");
    assert.ok(dash.stats);
    assert.equal(typeof dash.stats.queuedRuns, "number");
    assert.equal(typeof dash.stats.runnerCapacity, "number");
    assert.equal(typeof dash.stats.runnerAvailableSlots, "number");
    assert.ok(dash.pool, "dashboard should include a pool object");
    assert.equal(typeof dash.pool.queued, "number");
  });

  it("ships queue + pool UI helpers in app.js so the console can render them", async () => {
    const response = await raw("/public/app.js");
    assert.equal(response.status, 200);
    const code = response.data;
    assert.match(code, /renderQueueBanner/);
    assert.match(code, /run-queue-banner/);
    assert.match(code, /runnerCapacityCell/);
    assert.match(code, /renderRunnerPoolSummary/);
    assert.match(code, /chip-queue/);
    assert.match(code, /SMITHERS_RUNNER_CONCURRENCY/);
  });
});
