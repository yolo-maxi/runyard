#!/usr/bin/env node
import os from "node:os";
import { HubClient } from "./apiClient.js";
import { executeBuiltinWorkflow, writeLocalArtifacts } from "./workflows.js";

const baseUrl = process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117";
const token = process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN;
const name = process.env.SMITHERS_RUNNER_NAME || `${os.hostname()} runner`;
const tags = (process.env.SMITHERS_RUNNER_TAGS || "linux,macos,node,git,shell,web,smithers")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);
const intervalMs = Number(process.env.SMITHERS_RUNNER_INTERVAL_MS || 2500);

if (!token) {
  console.error("SMITHERS_HUB_TOKEN is required for the runner.");
  process.exit(1);
}

const client = new HubClient({ baseUrl, token });
let runnerId = process.env.SMITHERS_RUNNER_ID || "";
let busy = false;

async function register() {
  const response = await client.post("/api/runners/register", {
    id: runnerId || undefined,
    name,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    version: "0.1.0",
    tags
  });
  runnerId = response.runner.id;
  console.log(`Registered Smithers Hub runner ${runnerId} (${name})`);
}

async function event(runId, type, message, data = {}) {
  await client.post(`/api/runs/${runId}/events`, { type, message, data });
}

async function executeAssignment(assignment) {
  const { run, capability } = assignment;
  busy = true;
  try {
    await client.post(`/api/runs/${run.id}/start`, {});
    await event(run.id, "runner.started", `Runner ${name} started ${capability.name}`, { runnerId });
    const result = await executeBuiltinWorkflow(capability, run.input, (type, message, data) => event(run.id, type, message, data));
    const artifacts = writeLocalArtifacts(run.id, result.artifacts || []);
    for (const artifact of artifacts) {
      await client.post(`/api/runs/${run.id}/artifacts`, artifact);
    }
    await client.post(`/api/runs/${run.id}/complete`, { output: result.output || {} });
    console.log(`Completed ${run.id} (${capability.slug})`);
  } catch (error) {
    await client.post(`/api/runs/${run.id}/fail`, { error: error.stack || error.message });
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    busy = false;
  }
}

async function tick() {
  if (!runnerId || busy) return;
  await client.post(`/api/runners/${runnerId}/heartbeat`, { tags, currentRunId: busy ? "busy" : null });
  const assignment = await client.get(`/api/runners/${runnerId}/next-run`);
  if (assignment?.run) await executeAssignment(assignment);
}

async function main() {
  await register();
  await tick();
  setInterval(() => {
    tick().catch((error) => console.error("Runner tick failed:", error.message));
  }, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
