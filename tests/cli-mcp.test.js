import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJsonApiClient } from "./http-client.js";

const execFileAsync = promisify(execFile);

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-cli-mcp-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_cli_mcp_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_cli_mcp_token";
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

function parseToolText(response) {
  const text = response?.result?.content?.[0]?.text || "";
  return JSON.parse(text);
}

function startMcp() {
  const child = spawn(process.execPath, ["src/mcp.js"], {
    cwd: process.cwd(),
    env: { ...process.env, SMITHERS_HUB_URL: baseUrl, SMITHERS_HUB_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
        }, 5000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stop() {
      child.kill();
    }
  };
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

describe("CLI/MCP discovery and execution intent", () => {
  it("serves a menu and routes local vs remote runs to matching runner locations", async () => {
    const menu = await api("/api/menu");
    assert.equal(menu.hub.sourceOfTruth, true);
    assert.ok(menu.tools.includes("get_menu"));
    assert.ok(menu.executionModes.find((mode) => mode.id === "local"));
    assert.ok(menu.executionModes.find((mode) => mode.id === "remote"));

    const local = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "local route" },
        executionMode: "local",
        origin: { type: "api-test", label: "API local/remote test" }
      }
    });
    const remote = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "remote route" },
        executionMode: "remote",
        origin: { type: "api-test", label: "API local/remote test" }
      }
    });

    assert.equal(local.run.execution.mode, "local");
    assert.equal(local.run.execution.runnerLocation, "local");
    assert.equal(local.run.input.__execution.sourceOfTruth, "hub");
    assert.equal(local.outputsLocation, "hub");
    assert.equal(remote.run.execution.mode, "remote");
    assert.equal(remote.run.execution.runnerLocation, "vps");

    const localRunner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "local runner", hostname: "local", tags: ["smithers", "local"] }
    });
    const remoteRunner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "remote runner", hostname: "remote", tags: ["smithers", "vps"] }
    });

    const localClaim = await api(`/api/runners/${localRunner.runner.id}/next-run`);
    const remoteClaim = await api(`/api/runners/${remoteRunner.runner.id}/next-run`);
    assert.equal(localClaim.run.id, local.run.id);
    assert.equal(remoteClaim.run.id, remote.run.id);
  });

  it("CLI menu and run commands preserve Hub execution metadata", async () => {
    const common = ["src/cli.js", "--url", baseUrl, "--token", token, "--json"];
    const menu = await execFileAsync(process.execPath, [...common, "menu"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    const parsedMenu = JSON.parse(menu.stdout);
    assert.ok(parsedMenu.executionModes.find((mode) => mode.id === "local"));

    const run = await execFileAsync(
      process.execPath,
      [...common, "run", "hello", "--where", "local", "--input", '{"topic":"cli local"}'],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 }
    );
    const parsedRun = JSON.parse(run.stdout);
    assert.equal(parsedRun.run.execution.mode, "local");
    assert.equal(parsedRun.run.execution.runnerLocation, "local");
    assert.equal(parsedRun.run.origin.type, "cli");
    assert.equal(parsedRun.artifactsLocation, "hub");
  });

  it("MCP menu and run_capability expose the same local/remote path", async () => {
    const mcp = startMcp();
    try {
      const init = await mcp.call("initialize", { protocolVersion: "2024-11-05" });
      assert.equal(init.result.serverInfo.name, "runyard-mcp");

      const listed = await mcp.call("tools/list");
      assert.ok(listed.result.tools.find((tool) => tool.name === "get_menu"));
      for (const name of [
        "create_workflow",
        "update_workflow",
        "delete_workflow",
        "get_workflow_source",
        "list_workflow_versions",
        "export_workflow_package",
        "import_workflow_package",
        "list_run_drafts",
        "list_runs",
        "get_run_timeline",
        "rerun_workflow_run",
        "promote_run",
        "list_repo_options",
        "list_workflow_endpoints",
        "list_tokens",
        "list_secrets",
        "whoami",
        "list_schedules",
        "get_schedule",
        "preview_schedule",
        "create_schedule",
        "update_schedule",
        "enable_schedule",
        "disable_schedule",
        "delete_schedule",
        "run_schedule_now",
        "download_artifact",
        "list_approvals",
        "get_approval",
        "create_approval",
        "get_hook",
        "upsert_hook",
        "validate_hook",
        "get_audit_log",
        "list_alerts"
      ]) {
        assert.ok(listed.result.tools.find((tool) => tool.name === name), `${name} should be advertised`);
      }

      const menu = parseToolText(await mcp.call("tools/call", { name: "get_menu", arguments: {} }));
      assert.equal(menu.hub.sourceOfTruth, true);
      assert.ok(menu.executionModes.find((mode) => mode.id === "remote"));

      const workflows = parseToolText(await mcp.call("tools/call", { name: "list_workflows", arguments: {} }));
      assert.ok(Array.isArray(workflows.workflows || workflows.capabilities));

      const source = parseToolText(await mcp.call("tools/call", { name: "get_workflow_source", arguments: { id: "hello" } }));
      assert.equal((source.workflow || source.capability).slug, "hello");

      const versions = parseToolText(await mcp.call("tools/call", { name: "list_workflow_versions", arguments: { id: "hello" } }));
      assert.ok(Array.isArray(versions.versions));

      const runs = parseToolText(await mcp.call("tools/call", { name: "list_runs", arguments: { limit: 5 } }));
      assert.ok(Array.isArray(runs.runs));

      const repos = parseToolText(await mcp.call("tools/call", { name: "list_repo_options", arguments: {} }));
      assert.ok(Array.isArray(repos.repositories || repos.options || repos.repos));

      const run = parseToolText(await mcp.call("tools/call", {
        name: "run_capability",
        arguments: { id: "hello", input: { topic: "mcp remote" }, executionMode: "remote" }
      }));
      assert.equal(run.run.execution.mode, "remote");
      assert.equal(run.run.execution.runnerLocation, "vps");
      assert.equal(run.run.origin.type, "mcp");
      assert.equal(run.outputsLocation, "hub");

      const events = parseToolText(await mcp.call("tools/call", { name: "get_run_events", arguments: { runId: run.run.id } }));
      assert.ok(Array.isArray(events.events));

      const timeline = parseToolText(await mcp.call("tools/call", { name: "get_run_timeline", arguments: { runId: run.run.id } }));
      assert.ok(Array.isArray(timeline.entries));
      assert.ok("nextSince" in timeline);
      const page = parseToolText(await mcp.call("tools/call", {
        name: "get_run_timeline",
        arguments: { runId: run.run.id, since: timeline.nextSince, limit: 5 }
      }));
      assert.equal(page.since, timeline.nextSince);
    } finally {
      mcp.stop();
    }
  });

  // A CVM operator has only MCP: identity, schedules, approvals, artifact
  // content, and admin reads must all be reachable without the web UI.
  it("MCP alone covers identity, schedules, approvals, and artifact download", async () => {
    const mcp = startMcp();
    try {
      const me = parseToolText(await mcp.call("tools/call", { name: "whoami", arguments: {} }));
      assert.ok(Array.isArray(me.scopes || me.token?.scopes));

      const preview = parseToolText(await mcp.call("tools/call", {
        name: "preview_schedule",
        arguments: { cron: "0 9 * * *", timezone: "UTC" }
      }));
      assert.ok(Array.isArray(preview.nextRuns));

      const created = parseToolText(await mcp.call("tools/call", {
        name: "create_schedule",
        arguments: { name: "mcp daily hello", workflow: "hello", cron: "0 9 * * *", input: { topic: "scheduled" } }
      }));
      assert.equal(created.schedule.workflow, "hello");
      const scheduleId = created.schedule.id;

      const listed = parseToolText(await mcp.call("tools/call", { name: "list_schedules", arguments: {} }));
      assert.ok(listed.schedules.find((schedule) => schedule.id === scheduleId));

      const fired = parseToolText(await mcp.call("tools/call", { name: "run_schedule_now", arguments: { scheduleId } }));
      assert.equal(fired.run.origin.type, "schedule");

      const updated = parseToolText(await mcp.call("tools/call", {
        name: "update_schedule",
        arguments: { scheduleId, enabled: false }
      }));
      assert.equal(updated.schedule.enabled, false);

      const fetched = parseToolText(await mcp.call("tools/call", { name: "get_schedule", arguments: { scheduleId } }));
      assert.equal(fetched.schedule.enabled, false);

      const enabled = parseToolText(await mcp.call("tools/call", { name: "enable_schedule", arguments: { scheduleId } }));
      assert.equal(enabled.schedule.enabled, true);

      const disabled = parseToolText(await mcp.call("tools/call", { name: "disable_schedule", arguments: { scheduleId } }));
      assert.equal(disabled.schedule.enabled, false);

      const deleted = parseToolText(await mcp.call("tools/call", { name: "delete_schedule", arguments: { scheduleId } }));
      assert.equal(deleted.deleted, true);

      const ask = parseToolText(await mcp.call("tools/call", {
        name: "create_approval",
        arguments: {
          title: "MCP escalation",
          description: "raised through MCP",
          ask: { action: "Confirm the MCP escalation path", reason: "parity test", audience: "operator" }
        }
      }));
      const approvalId = ask.approval.id;
      const pending = parseToolText(await mcp.call("tools/call", { name: "list_approvals", arguments: { status: "pending" } }));
      assert.ok(pending.approvals.find((approval) => approval.id === approvalId));
      const card = parseToolText(await mcp.call("tools/call", { name: "get_approval", arguments: { approvalId } }));
      assert.equal(card.approval.id, approvalId);
      parseToolText(await mcp.call("tools/call", { name: "approve_run", arguments: { approvalId, comment: "ok" } }));
      const resolved = parseToolText(await mcp.call("tools/call", { name: "list_approvals", arguments: { status: "resolved" } }));
      const resolvedCard = resolved.approvals.find((approval) => approval.id === approvalId);
      assert.equal(resolvedCard.resolution, "approved");

      const artifactRun = parseToolText(await mcp.call("tools/call", {
        name: "run_workflow",
        arguments: { id: "hello", input: { topic: "artifact download" } }
      }));
      const stored = await api(`/api/runs/${artifactRun.run.id}/artifacts`, {
        method: "POST",
        body: { name: "report.txt", mimeType: "text/plain", content: "artifact body via mcp" }
      });
      const downloadResponse = await mcp.call("tools/call", {
        name: "download_artifact",
        arguments: { artifactId: stored.artifact.id }
      });
      assert.equal(downloadResponse.result.content[0].text, "artifact body via mcp");

      const audit = parseToolText(await mcp.call("tools/call", { name: "get_audit_log", arguments: { limit: 20 } }));
      assert.ok(Array.isArray(audit.audit));
      const alerts = parseToolText(await mcp.call("tools/call", { name: "list_alerts", arguments: {} }));
      assert.ok(Array.isArray(alerts.alerts));
    } finally {
      mcp.stop();
    }
  });

  // Engine-approval bridge cards are ordinary approval rows: prove the whole
  // human loop is reachable through CLI and MCP, not just the web UI, and that
  // resolving the card never disturbs the running run (the runner applies the
  // decision to the engine; the Hub only records it).
  it("surfaces and resolves engine-approval cards through CLI and MCP", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { topic: "engine gate" }, origin: { type: "api-test", label: "engine approval surface test" } }
    });
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "engine runner", hostname: "engine", tags: ["smithers", "vps"] }
    });
    const claim = await api(`/api/runners/${runner.runner.id}/next-run`);
    assert.equal(claim.run.id, created.run.id);
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });

    // Simulate the runner bridge surfacing an engine-level <Approval> pause.
    await api(`/api/runs/${created.run.id}/events`, {
      method: "POST",
      body: {
        type: "engine.approval.waiting",
        message: "paused at engine approval",
        data: { smithersRunId: "run_sm_surface", nodeId: "ship-gate" }
      }
    });
    const card = await api("/api/approvals", {
      method: "POST",
      body: {
        runId: created.run.id,
        title: "Engine approval: hello · ship-gate",
        requestedBy: "runner: engine runner",
        payload: { kind: "engine_approval", smithersRunId: "run_sm_surface", nodeId: "ship-gate" }
      }
    });
    assert.equal(card.approval.status, "pending");

    // The hold is visible on the run detail (this is what defers the runner deadline).
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.approvalHold, true);

    // CLI surface: the pending engine card is listed.
    const common = ["src/cli.js", "--url", baseUrl, "--token", token, "--json"];
    const cliList = await execFileAsync(process.execPath, [...common, "approvals"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024
    });
    const cliApprovals = JSON.parse(cliList.stdout);
    assert.ok(cliApprovals.find((approval) => approval.id === card.approval.id));

    // MCP surface: listed pending, then approved through the MCP tool.
    const mcp = startMcp();
    try {
      await mcp.call("initialize", { protocolVersion: "2024-11-05" });
      const pending = parseToolText(await mcp.call("tools/call", { name: "list_pending_approvals", arguments: {} }));
      assert.ok(pending.approvals.find((approval) => approval.id === card.approval.id));

      const resolved = parseToolText(await mcp.call("tools/call", {
        name: "approve_run",
        arguments: { approvalId: card.approval.id, comment: "ship it" }
      }));
      assert.equal(resolved.approval.status, "resolved");
      assert.equal(resolved.approval.resolution, "approved");
      assert.equal(resolved.approval.resolvedVia, "human");
    } finally {
      mcp.stop();
    }

    // The running run is untouched by card resolution, and the event-based
    // engine hold still protects it until the engine actually resumes.
    const afterResolve = await api(`/api/runs/${created.run.id}`);
    assert.equal(afterResolve.run.status, "running");
    assert.equal(afterResolve.approvalHold, true);

    // Engine resumes (runner bridge posts the resumed event): hold releases.
    await api(`/api/runs/${created.run.id}/events`, {
      method: "POST",
      body: {
        type: "engine.approval.resumed",
        message: "gate decided",
        data: { smithersRunId: "run_sm_surface", nodeId: "ship-gate", engineDecision: "approved" }
      }
    });
    const afterResume = await api(`/api/runs/${created.run.id}`);
    assert.equal(afterResume.approvalHold, false);
    assert.equal(afterResume.run.status, "running");
  });
});
