// Deterministic demo traffic generator for the Electric demo.
//
// This drives the REAL RunYard event pipeline: it inserts run rows and calls the
// real db.addRunEvent() (which persists to run_events and publishes to the event
// bus). The projector mirrors those into Postgres and Electric streams them live
// to the UI. Only the trace *content* is synthetic; the data path is production.
//
// Enabled via RUNYARD_DEMO_TRAFFIC=1. Never runs against production (separate
// process, separate DB, separate port).
import * as db from "../db.js";
import { id, now } from "../ids.js";

const RUNNERS = [
  { name: "hetzner-electric-runner", platform: "linux", tags: ["hetzner", "electric", "primary"] },
  { name: "edge-preview-runner", platform: "linux", tags: ["edge", "preview"] }
];

// Realistic CLI/agent trace lines, grouped into phases so a run reads like a real
// Smithers/Claude Code session streaming its work.
const TRACE_SCRIPT = [
  ["runner.started", "Runner claimed run and prepared workspace"],
  ["smithers.dispatched", "Dispatched workflow to Smithers orchestrator"],
  ["agent.thinking", "Planning: read repo, locate the querying layer, design the change"],
  ["tool.shell", "$ git status --short"],
  ["tool.shell", "$ rg -n \"queryCollectionOptions\" web/lib"],
  ["agent.tool_use", "read_file web/lib/collections.js (lines 1-80)"],
  ["agent.thinking", "The runs collection polls /api/runs every 4s. Replacing with an Electric shape."],
  ["tool.edit", "edit web/lib/collections.js  (+38 -12)"],
  ["tool.shell", "$ pnpm build:web"],
  ["log.info", "esbuild: bundled public/app.js in 412ms"],
  ["agent.tool_use", "write_file src/electric/electricProxy.js"],
  ["tool.shell", "$ node --test tests/electric-projector.test.js"],
  ["log.info", "tests: 6 passing (214ms)"],
  ["agent.thinking", "Verifying the live shape stream updates the UI without polling"],
  ["tool.shell", "$ curl -s /api/electric/v1/shape?table=runs&offset=-1 | head"],
  ["log.info", "electric-handle acquired; snapshot -> up-to-date"],
  ["workflow.step", "Gate: build + tests green"],
  ["agent.summary", "Query layer now reactive via Electric shapes; traces stream live"]
];

const CAPS_FALLBACK = [
  { slug: "improve/frontend", name: "Improve Frontend" },
  { slug: "audit/smart-contract", name: "Smart Contract Audit" }
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function ensureRunners() {
  const existing = db.db.prepare("SELECT id FROM runners WHERE name = ?");
  const insert = db.db.prepare(
    `INSERT INTO runners (id, name, hostname, platform, version, tags, status, capacity, active_runs, created_at, last_heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ids = [];
  for (const r of RUNNERS) {
    const found = existing.get(r.name);
    if (found) { ids.push(found.id); continue; }
    const rid = id("runner");
    insert.run(rid, r.name, "electric-demo", r.platform, "demo", JSON.stringify(r.tags), "online", 2, 0, now(), now());
    ids.push(rid);
  }
  return ids;
}

function pickCapability() {
  const rows = db.db.prepare(
    "SELECT id, slug, name FROM capabilities WHERE enabled = 1 ORDER BY RANDOM() LIMIT 1"
  ).all();
  if (rows.length) return rows[0];
  // Fresh DB with no seeds: synthesize one.
  const cap = pick(CAPS_FALLBACK);
  const cid = id("cap");
  db.db.prepare(
    `INSERT INTO capabilities (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO NOTHING`
  ).run(cid, cap.slug, cap.name, now(), now());
  return db.db.prepare("SELECT id, slug, name FROM capabilities WHERE slug = ?").get(cap.slug);
}

function heartbeat(runnerIds) {
  const stmt = db.db.prepare("UPDATE runners SET last_heartbeat_at = ?, status = 'online' WHERE id = ?");
  for (const rid of runnerIds) stmt.run(now(), rid);
}

async function streamRun({ runnerId, logger }) {
  const cap = pickCapability();
  const runId = id("run");
  const startedAt = now();
  db.db.prepare(
    `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version,
       runner_id, status, current_step, input, output, error, created_at, assigned_at, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 'running', 'starting', '{}', NULL, NULL, ?, ?, ?, NULL, ?)`
  ).run(runId, cap.id, cap.slug, cap.name, runnerId, startedAt, startedAt, startedAt, startedAt);
  db.db.prepare("UPDATE runners SET current_run_id = ?, active_runs = active_runs + 1 WHERE id = ?").run(runId, runnerId);
  logger.log?.(`[demo-traffic] started ${runId} (${cap.slug})`);

  let step = 0;
  for (const [type, message] of TRACE_SCRIPT) {
    db.addRunEvent(runId, type, message, { step, phase: type.split(".")[0] });
    step += 1;
    if (type === "workflow.step") {
      db.db.prepare("UPDATE runs SET current_step = ?, updated_at = ? WHERE id = ?").run(message, now(), runId);
    }
    await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 700)));
  }

  const completedAt = now();
  db.db.prepare(
    "UPDATE runs SET status = 'succeeded', current_step = 'done', output = ?, completed_at = ?, updated_at = ? WHERE id = ?"
  ).run(JSON.stringify({ ok: true, summary: "Electric-backed query layer verified" }), completedAt, completedAt, runId);
  db.db.prepare("UPDATE runners SET current_run_id = NULL, active_runs = MAX(0, active_runs - 1) WHERE id = ?").run(runnerId);
  db.addRunEvent(runId, "run.completed", "Run completed successfully", {});
  logger.log?.(`[demo-traffic] completed ${runId}`);
}

export function startDemoTraffic({ concurrency = 2, gapMs = 4000, logger = console } = {}) {
  const runnerIds = ensureRunners();
  let stopped = false;
  const hb = setInterval(() => heartbeat(runnerIds), 10_000);
  if (hb.unref) hb.unref();

  async function worker(runnerId) {
    while (!stopped) {
      try {
        await streamRun({ runnerId, logger });
      } catch (err) {
        logger.error?.(`[demo-traffic] run failed: ${err?.message || err}`);
      }
      await new Promise((r) => setTimeout(r, gapMs + Math.floor(Math.random() * gapMs)));
    }
  }

  const workers = runnerIds.slice(0, concurrency).map((rid) => worker(rid));
  return {
    stop() {
      stopped = true;
      clearInterval(hb);
      return Promise.allSettled(workers);
    }
  };
}
