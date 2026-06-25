#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let baseUrl = String(process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117").replace(/\/$/, "");
let token = process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN || "";
const fixtureTarget = path.join(root, "tests", "fixtures", "smart-contract-audit", "contracts");
const target = path.resolve(process.env.RUNYARD_SMOKE_TARGET || process.argv[2] || fixtureTarget);
const timeoutMs = positiveInt(process.env.RUNYARD_SMOKE_TIMEOUT_MS, 25 * 60_000);
const pollMs = positiveInt(process.env.RUNYARD_SMOKE_POLL_MS, 5_000);
const maxAgents = Math.max(1, Math.min(2, positiveInt(process.env.RUNYARD_SMOKE_MAX_AGENTS, 1)));
const isolated = /^(1|true|yes|on)$/i.test(String(process.env.RUNYARD_SMOKE_ISOLATED || ""));
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
let isolatedServer = null;
let runnerProcess = null;
let isolatedWorkspace = "";

class SmokeFailure extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "SmokeFailure";
    this.detail = detail;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function fail(message, detail = null) {
  throw new SmokeFailure(message, detail);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Hub ${options.method || "GET"} ${pathname} failed (${response.status}): ${data?.error || text}`);
  }
  return data;
}

function outputFromDetail(detail) {
  return detail?.run?.output && typeof detail.run.output === "object" ? detail.run.output : {};
}

function findingsCount(output) {
  const outputs = output?.outputs && typeof output.outputs === "object" ? output.outputs : {};
  let count = 0;
  for (const value of Object.values(outputs)) {
    if (value && typeof value === "object" && Array.isArray(value.findings)) count += value.findings.length;
  }
  return count;
}

function reportOutput(output) {
  const report = output?.outputs?.report;
  return report && typeof report === "object" ? report : null;
}

function isReportArtifact(artifact) {
  return artifact?.mimeType === "text/markdown"
    && artifact?.metadata?.generatedBy === "smithers-runner"
    && artifact?.metadata?.sourceNode === "report";
}

async function findReportArtifact(detail) {
  const ids = [detail?.run?.id, detail?.run?.supervision?.childRunId].filter(Boolean);
  for (const runId of [...new Set(ids)]) {
    const listed = await api(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
    const artifact = (listed.artifacts || []).find(isReportArtifact);
    if (artifact) return { runId, artifact };
  }
  return null;
}

async function startIsolatedHub() {
  const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-audit-smoke-"));
  const dataDir = path.join(temp, "data");
  const workspace = path.join(temp, "workspace");
  isolatedWorkspace = workspace;
  mkdirSync(path.join(workspace, ".smithers"), { recursive: true });
  process.env.SMITHERS_HUB_ROOT = root;
  process.env.SMITHERS_HUB_DATA_DIR = dataDir;
  process.env.SMITHERS_HUB_DB = path.join(dataDir, "smoke.sqlite");
  process.env.SMITHERS_HUB_SESSION_SECRET = "runyard-smoke-session-secret";
  process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_smoke_eval_token";
  process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

  const init = spawnSync("smithers", ["init"], { cwd: workspace, stdio: "inherit" });
  if (init.status !== 0) fail("smithers init failed for isolated smoke workspace");
  cpSync(path.join(root, "workflow-templates", "workflows"), path.join(workspace, ".smithers", "workflows"), { recursive: true });
  cpSync(path.join(root, "workflow-templates", "examples"), path.join(workspace, ".smithers", "examples"), { recursive: true });

  const { app } = await import("../src/server.js");
  isolatedServer = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  baseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
  token = process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN;
  return { temp, workspace };
}

async function startIsolatedRunner() {
  runnerProcess = spawn(process.execPath, [path.join(root, "src", "runner.js")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      SMITHERS_HUB_URL: baseUrl,
      SMITHERS_HUB_TOKEN: token,
      SMITHERS_WORKSPACE: isolatedWorkspace,
      SMITHERS_RUNNER_LOCATION: "local",
      SMITHERS_RUNNER_TAGS: "smithers,local",
      SMITHERS_RUNNER_CONCURRENCY: "2",
      SMITHERS_RUNNER_INTERVAL_MS: "1000",
      SMITHERS_POLL_MS: "2000",
      SMITHERS_MAX_RUN_MS: String(Math.max(60_000, timeoutMs - 90_000)),
      SMITHERS_RUNNER_EXIT_AFTER_RUNS: "1"
    }
  });
}

async function cleanupIsolatedHub() {
  if (runnerProcess) {
    await new Promise((resolve) => {
      if (runnerProcess.exitCode != null) return resolve();
      runnerProcess.once("exit", resolve);
    });
  }
  if (isolatedServer) {
    await new Promise((resolve) => isolatedServer.close(resolve));
  }
}

async function main() {
  try {
    if (!existsSync(target)) fail(`target fixture does not exist: ${target}`);
    if (isolated) await startIsolatedHub();
    if (!token) fail("set SMITHERS_HUB_TOKEN, HUB_TOKEN, or SMITHERS_HUB_BOOTSTRAP_TOKEN");

    console.log(`smart-contract-audit smoke: hub=${baseUrl} target=${target} timeoutMs=${timeoutMs} isolated=${isolated}`);

    const created = await api("/api/capabilities/smart-contract-audit/run", {
      method: "POST",
      body: {
        input: {
          target,
          scope: "Phase-0 smoke eval against a tiny fixture. Keep findings concise and report even if there are no confirmed issues.",
          maxAgents
        },
        origin: {
          type: "phase-0-smoke-eval",
          label: "Phase 0 smart-contract-audit smoke eval"
        }
      }
    });

    const runId = created?.run?.id;
    if (!runId) fail("Hub did not return a run id", created);
    console.log(`smart-contract-audit smoke: submitted run ${runId}`);
    if (isolated) await startIsolatedRunner();

    const deadline = Date.now() + timeoutMs;
    let detail = null;
    while (Date.now() < deadline) {
      detail = await api(`/api/runs/${encodeURIComponent(runId)}`);
      const status = detail?.run?.status || "";
      console.log(`smart-contract-audit smoke: run ${runId} status=${status} step=${detail?.run?.currentStep || ""}`);
      if (terminalStatuses.has(status)) break;
      await sleep(pollMs);
    }

    if (!detail || !terminalStatuses.has(detail.run?.status)) {
      fail(`run ${runId} did not reach a terminal status within ${timeoutMs}ms`, detail);
    }
    if (detail.run.status !== "succeeded") {
      fail(`run ${runId} ended as ${detail.run.status}`, { error: detail.run.error, run: detail.run });
    }

    const output = outputFromDetail(detail);
    const report = reportOutput(output);
    if (!report || typeof report.report !== "string" || !report.report.trim()) {
      fail("succeeded run did not expose a report output", { output });
    }
    const findings = findingsCount(output);
    if (!Number.isFinite(findings) || findings < 0) {
      fail("succeeded run did not expose a valid findings count", { output });
    }
    const reportArtifact = await findReportArtifact(detail);
    if (!reportArtifact) {
      fail("succeeded run did not store a report markdown artifact", {
        runId,
        childRunId: detail.run?.supervision?.childRunId || ""
      });
    }

    console.log(JSON.stringify({
      ok: true,
      runId,
      childRunId: detail.run?.supervision?.childRunId || "",
      status: detail.run.status,
      findings,
      criticalHigh: Number(report.criticalHigh || 0),
      reportArtifact
    }, null, 2));
  } catch (error) {
    if (error instanceof SmokeFailure) {
      if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
      console.error(`smart-contract-audit smoke failed: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    if (isolated) await cleanupIsolatedHub();
  }
}

await main();
