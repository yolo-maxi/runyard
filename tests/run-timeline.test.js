import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-timeline-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "1";
// Keep the explicit flag so this suite still exercises the intended contract
// if another test or shell exports RUNYARD_RUN_TIMELINE=0.
process.env.RUNYARD_RUN_TIMELINE = "1";

const { app } = await import("../src/server.js");
const {
  RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME,
  setRunObstructionAnalyzerForTest
} = await import("../src/runObstructionAnalysis.js");
const { updateRun } = await import("../src/db.js");

let server;
let baseUrl;
const token = "shub_test_token";
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitForTimelineKind(runId, kind, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await api(`/api/runs/${runId}/timeline?limit=1000`);
    if ((page.entries || []).some((entry) => entry.kind === kind)) return page;
    await sleep(20);
  }
  throw new Error(`timed out waiting for timeline kind ${kind}`);
}

function fakeObstructionAnalysis() {
  return {
    severity: "low",
    confidence: "medium",
    summary: "Bounded test obstruction analysis.",
    observations: [
      { evidence: "evidence", inference: "inference", severity: "low", confidence: "medium" }
    ],
    obstructions: [],
    suggestedWorkflowImprovements: [],
    suggestedAgentImprovements: [],
    suggestedSkillOrKnowledgeImprovements: [],
    followUpQuestions: [],
    doNotAutoMutate: false
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

describe("GET /api/runs/:id/timeline", () => {
  it("merges status, event, artifact, retrospective, and obstruction kinds in ascending order", async () => {
    setRunObstructionAnalyzerForTest(async () => ({
      provider: "test",
      model: "fake",
      analysis: fakeObstructionAnalysis()
    }));
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "timeline run" } }
      });
      const runId = created.run.id;
      await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });
      updateRun(runId, {
        started_at: new Date(Date.now() - 25 * 60_000).toISOString()
      });
      await sleep(5);
      await api(`/api/runs/${runId}/events`, {
        method: "POST",
        body: { type: "workflow.step", message: "running step" }
      });
      await sleep(5);
      await api(`/api/runs/${runId}/events`, {
        method: "POST",
        body: { type: "runner.warning", message: "retry/fallback evidence for obstruction timeline" }
      });
      await sleep(5);
      const usageResponse = await api(`/api/runs/${runId}/usage`, {
        method: "POST",
        body: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          promptTokens: 6,
          completionTokens: 1744,
          source: "runner",
          nodeId: "factory",
          requestId: "smithers-run:18"
        }
      });
      assert.equal(usageResponse.usage.totalTokens, 1750);
      assert.equal(usageResponse.budget.exceeded, false);
      await sleep(5);
      await api(`/api/runs/${runId}/artifacts`, {
        method: "POST",
        body: {
          name: "report.md",
          mimeType: "text/markdown",
          contentBase64: Buffer.from("# done").toString("base64")
        }
      });
      await sleep(5);
      await api(`/api/runs/${runId}/complete`, { method: "POST", body: { output: { ok: true } } });
      // Obstruction artifact is scheduled async on the terminal hook.
      await waitForTimelineKind(runId, "obstruction");

      const page = await api(`/api/runs/${runId}/timeline?limit=1000`);
      assert.equal(page.runId, runId);
      assert.equal(Array.isArray(page.entries), true);

      // Every entry carries the normalized {ts, kind, source, payload} shape.
      for (const entry of page.entries) {
        assert.ok(entry.ts, "entry missing ts");
        assert.ok(entry.kind, "entry missing kind");
        assert.ok(entry.source, "entry missing source");
        assert.ok(entry.payload && typeof entry.payload === "object", "entry missing payload");
      }

      const kinds = new Set(page.entries.map((entry) => entry.kind));
      for (const required of ["status", "event", "artifact", "retrospective", "obstruction"]) {
        assert.ok(kinds.has(required), `timeline should include kind=${required}; got ${[...kinds].join(",")}`);
      }

      // Ascending sort by ts.
      for (let i = 1; i < page.entries.length; i += 1) {
        assert.ok(
          page.entries[i - 1].ts <= page.entries[i].ts,
          `timeline must be sorted ascending; ${page.entries[i - 1].ts} > ${page.entries[i].ts} at ${i}`
        );
      }

      // Source attribution: artifact-kind entries point at the artifacts table,
      // status-kind entries point at the runs row, event-kind entries point at
      // run_events. This is the contract MCP / CLI tail relies on.
      const statusEntries = page.entries.filter((e) => e.kind === "status");
      assert.ok(statusEntries.every((e) => e.source === "runs"));
      assert.ok(statusEntries.find((e) => e.payload.transition === "created"));
      assert.ok(statusEntries.find((e) => e.payload.transition === "started"));
      assert.ok(statusEntries.find((e) => e.payload.transition === "completed" && e.payload.status === "succeeded"));

      const eventEntries = page.entries.filter((e) => e.kind === "event");
      assert.ok(eventEntries.every((e) => e.source === "run_events"));

      // Usage streams as a first-class run event and lands in timeline order.
      const usageEntry = eventEntries.find((e) => e.payload.type === "run.usage");
      assert.ok(usageEntry, "timeline should include the run.usage event");
      assert.equal(usageEntry.payload.data.record.model, "claude-opus-4-7");
      assert.equal(usageEntry.payload.data.totals.totalTokens, 1750);

      // The aggregate is persisted on the run and served on detail + /usage.
      const detail = await api(`/api/runs/${runId}`);
      assert.equal(detail.run.usage.totalTokens, 1750);
      assert.equal(detail.run.usage.byModel["claude-opus-4-7"].calls, 1);
      const usagePayload = await api(`/api/runs/${runId}/usage`);
      assert.equal(usagePayload.usage.totalTokens, 1750);
      assert.equal(usagePayload.records.length, 1);
      assert.equal(usagePayload.records[0].source, "runner");
      assert.equal(usagePayload.budgetStop, null);

      const artifactEntries = page.entries.filter((e) => e.kind === "artifact");
      assert.ok(artifactEntries.every((e) => e.source === "artifacts:runner"));
      assert.ok(artifactEntries.find((e) => e.payload.name === "report.md"));

      const retroEntries = page.entries.filter((e) => e.kind === "retrospective");
      assert.equal(retroEntries.length, 1);
      assert.equal(retroEntries[0].source, "artifacts:retrospective");

      const obstructionEntries = page.entries.filter((e) => e.kind === "obstruction");
      assert.equal(obstructionEntries.length, 1);
      assert.equal(obstructionEntries[0].source, "artifacts:obstruction");
      assert.equal(obstructionEntries[0].payload.name, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
    } finally {
      setRunObstructionAnalyzerForTest(null);
    }
  });

  it("paginates with since=<ts> and limit=<n> without dropping or duplicating entries", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "timeline pagination" } }
    });
    const runId = created.run.id;
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });
    // Sleep between events so each event row gets a distinct millisecond
    // timestamp; this isolates the test from the cursor's tie-handling code
    // path (which is exercised by the production server but not the goal of
    // this assertion).
    for (let i = 0; i < 6; i += 1) {
      await api(`/api/runs/${runId}/events`, {
        method: "POST",
        body: { type: "workflow.step", message: `step ${i}` }
      });
      await sleep(5);
    }
    await api(`/api/runs/${runId}/complete`, { method: "POST", body: { output: { ok: true } } });

    const full = await api(`/api/runs/${runId}/timeline?limit=1000`);
    assert.ok(full.entries.length >= 8, `expected >=8 entries, got ${full.entries.length}`);
    assert.equal(full.truncated, false);

    // First page: ask for 3. The server's tie-handling may return fewer than
    // limit when the cut-line lands inside a group of entries that share the
    // same ts (so the next page can use the exclusive cursor cleanly), so
    // assert <=3 and >=1, plus truncated=true.
    const first = await api(`/api/runs/${runId}/timeline?limit=3`);
    assert.ok(first.entries.length >= 1 && first.entries.length <= 3, `unexpected first page size ${first.entries.length}`);
    assert.equal(first.truncated, true);
    assert.ok(first.nextSince, "truncated response must expose a nextSince cursor");

    // Walk the pages with the cursor; collect every entry the server emits.
    // Assertions: every entry past the first page is strictly newer than the
    // previous nextSince, and the concatenation of pages equals `full` with no
    // duplicates and no drops.
    const seen = [...first.entries];
    let cursor = first.nextSince;
    let truncated = first.truncated;
    while (truncated) {
      const page = await api(`/api/runs/${runId}/timeline?limit=3&since=${encodeURIComponent(cursor)}`);
      for (const entry of page.entries) {
        assert.ok(entry.ts > cursor, `paged entry ${entry.ts} must be > cursor ${cursor}`);
        seen.push(entry);
      }
      truncated = page.truncated;
      cursor = page.nextSince || cursor;
    }
    assert.equal(seen.length, full.entries.length, "paged entries must cover the full timeline");
    const key = (entry) => `${entry.kind}|${entry.source}|${entry.ts}|${JSON.stringify(entry.payload)}`;
    const seenKeys = new Set(seen.map(key));
    assert.equal(seenKeys.size, seen.length, "paged entries must be unique");
    for (const entry of full.entries) {
      assert.ok(seenKeys.has(key(entry)), "every full-timeline entry must appear in the paged stream");
    }

    // Draining past the end yields no entries and a stable cursor.
    const tail = full.entries[full.entries.length - 1].ts;
    const empty = await api(`/api/runs/${runId}/timeline?since=${encodeURIComponent(tail)}`);
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.truncated, false);
  });

  it("returns 404 for an unknown run", async () => {
    const response = await fetch(`${baseUrl}/api/runs/nope_does_not_exist/timeline`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 404);
  });

  it("requires authentication", async () => {
    const response = await fetch(`${baseUrl}/api/runs/whatever/timeline`);
    assert.equal(response.status, 401);
  });

  it("streams the timeline through the CLI tail command", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "cli tail" } }
    });
    const runId = created.run.id;
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${runId}/events`, {
      method: "POST",
      body: { type: "workflow.step", message: "cli-visible step" }
    });

    const result = await runCli(["src/cli.js", "--url", baseUrl, "--token", token, "tail", "--once", runId]);
    assert.equal(result.status, 0, result.stderr || result.stdout || result.signal);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, `expected timeline NDJSON, got ${result.stdout}`);
    const entries = lines.map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.kind === "status" && entry.payload.transition === "created"));
    assert.ok(entries.some((entry) => entry.kind === "event" && entry.payload.message === "cli-visible step"));
  });
});
