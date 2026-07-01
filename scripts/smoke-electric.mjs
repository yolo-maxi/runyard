#!/usr/bin/env node
// Live smoke for the Electric demo. Proves the full path:
//   SQLite write -> projector -> Postgres -> Electric shape log -> auth proxy.
//
// Usage: node scripts/smoke-electric.mjs
// Env: SMOKE_BASE (default http://127.0.0.1:3118), SMOKE_TOKEN (or reads
//      data-demo/DEMO_ADMIN_TOKEN.txt).
import { readFileSync } from "node:fs";
import { classifyShapeMessages } from "../web/lib/shapeProtocol.js";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3118";
const TOKEN =
  process.env.SMOKE_TOKEN ||
  readFileSync(new URL("../data-demo/DEMO_ADMIN_TOKEN.txt", import.meta.url), "utf8").trim();

const H = { authorization: `Bearer ${TOKEN}`, accept: "application/json" };
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function shapeUrl(table, { offset, handle, live, runId }) {
  const u = new URL("/api/electric/v1/shape", BASE);
  u.searchParams.set("table", table);
  if (runId) u.searchParams.set("run_id", runId);
  u.searchParams.set("replica", "full");
  u.searchParams.set("offset", offset);
  if (handle) u.searchParams.set("handle", handle);
  if (live) u.searchParams.set("live", "true");
  return u;
}

// Page a shape to up-to-date, returning {rows, offset, handle}.
async function snapshot(table, { runId } = {}) {
  let offset = "-1";
  let handle = null;
  const rows = new Map();
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(await shapeUrl(table, { offset, handle, runId }), { headers: H });
    if (!res.ok) fail(`shape ${table} http ${res.status}`);
    handle = res.headers.get("electric-handle") || handle;
    const utdHeader = res.headers.get("electric-up-to-date") != null;
    const newOffset = res.headers.get("electric-offset");
    const msgs = res.status === 204 ? [] : await res.json();
    const { ops, upToDate } = classifyShapeMessages(msgs);
    for (const op of ops) {
      if (op.operation === "delete") rows.delete(op.key);
      else rows.set(op.key, op.value);
    }
    if (newOffset) offset = newOffset;
    if (utdHeader || upToDate) return { rows: [...rows.values()], offset, handle };
  }
  fail(`shape ${table} did not reach up-to-date`);
}

// Long-poll live for up to timeoutMs; return number of change ops observed.
async function countLiveOps(table, { offset, handle, runId }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(6000, deadline - Date.now()));
    let res;
    try {
      res = await fetch(await shapeUrl(table, { offset, handle, live: true, runId }), { headers: H, signal: ac.signal });
    } catch {
      clearTimeout(t);
      continue;
    }
    clearTimeout(t);
    if (res.status === 409) fail("shape rotated mid-smoke");
    handle = res.headers.get("electric-handle") || handle;
    const newOffset = res.headers.get("electric-offset");
    const msgs = res.status === 204 ? [] : await res.json();
    const { ops } = classifyShapeMessages(msgs);
    count += ops.length;
    if (newOffset) offset = newOffset;
    if (count > 0) break;
  }
  return count;
}

async function main() {
  // 1. Health + status.
  const health = await (await fetch(`${BASE}/healthz`)).json();
  if (health.status !== "ok") fail("healthz not ok");
  const status = await (await fetch(`${BASE}/api/electric/status`, { headers: H })).json();
  if (status.electric !== "active") fail(`electric not active: ${status.electric}`);
  if (!status.projector || status.projector.ticks < 1) fail("projector not ticking");
  console.log(`OK  health + status: electric=${status.electric}, projector ticks=${status.projector.ticks}, events mirrored=${status.projector.events}`);

  // 2. Unauth is rejected.
  const unauth = await fetch(await shapeUrl("runs", { offset: "-1" }));
  if (unauth.status !== 401) fail(`unauth shape returned ${unauth.status}, expected 401`);
  console.log("OK  auth proxy rejects unauthenticated shape requests (401)");

  // 3. Runs shape snapshot has data.
  const runs = await snapshot("runs");
  if (!runs.rows.length) fail("runs shape empty");
  const running = runs.rows.find((r) => r.status === "running") || runs.rows[0];
  console.log(`OK  runs shape synced ${runs.rows.length} run(s); sample=${running.id} (${running.status})`);

  // 4. Live: a change op arrives on the runs shape within 20s (demo traffic).
  const runOps = await countLiveOps("runs", runs, 20_000);
  if (runOps < 1) fail("no live change on runs shape within 20s (is demo traffic on?)");
  console.log(`OK  runs shape streamed ${runOps} live change op(s)`);

  // 5. Live: trace events stream for a run within 20s.
  const evShape = await snapshot("run_events", { runId: running.id });
  const evOps = await countLiveOps("run_events", { ...evShape, runId: running.id }, 20_000);
  console.log(`OK  run_events shape for ${running.id}: ${evShape.rows.length} events synced, ${evOps} streamed live`);

  console.log("\nALL SMOKE CHECKS PASSED");
}

main().catch((e) => fail(e?.stack || String(e)));
