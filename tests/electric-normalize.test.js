import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRunRow,
  normalizeRunEventRow,
  normalizeRunnerRow,
  normalizeCapabilityRow,
  normalizeApprovalRow,
  normalizeArtifactRow
} from "../web/lib/electricNormalize.js";

test("normalizeRunRow maps snake_case + parses json + coerces numbers", () => {
  const run = normalizeRunRow({
    id: "run_1",
    capability_slug: "improve/frontend",
    capability_name: "Improve Frontend",
    status: "running",
    current_step: "build",
    input: '{"repo":"x"}',
    output: null,
    attempt: "2",
    repair_count: "0",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:01:00.000Z"
  });
  assert.equal(run.capabilitySlug, "improve/frontend");
  assert.equal(run.currentStep, "build");
  assert.deepEqual(run.input, { repo: "x" });
  assert.equal(run.output, null);
  assert.equal(run.attempt, 2);
  assert.equal(run.createdAt, "2026-07-01T00:00:00.000Z");
});

test("normalizeRunEventRow parses data json and decorates the event", () => {
  const ev = normalizeRunEventRow({
    id: "evt_1",
    run_id: "run_1",
    type: "agent.thinking",
    message: "planning",
    data: '{"step":3}',
    created_at: "2026-07-01T00:00:00.000Z"
  });
  assert.equal(ev.runId, "run_1");
  assert.deepEqual(ev.data, { step: 3 });
  // decorateEvent adds a classification category — proves decoration ran.
  assert.ok("category" in ev || "severity" in ev);
});

test("normalizeRunnerRow computes online + availableSlots from heartbeat", () => {
  const fresh = normalizeRunnerRow({
    id: "runner_1",
    name: "r1",
    tags: '["hetzner"]',
    status: "online",
    capacity: "2",
    active_runs: "1",
    last_heartbeat_at: new Date().toISOString()
  });
  assert.equal(fresh.online, true);
  assert.deepEqual(fresh.tags, ["hetzner"]);
  assert.equal(fresh.capacity, 2);
  assert.equal(fresh.availableSlots, 1);

  const stale = normalizeRunnerRow({
    id: "runner_2",
    name: "r2",
    status: "online",
    capacity: "1",
    active_runs: "0",
    last_heartbeat_at: "2000-01-01T00:00:00.000Z"
  });
  assert.equal(stale.online, false);
  assert.equal(stale.status, "offline");
});

test("normalizeCapabilityRow parses keywords and enabled boolean", () => {
  const cap = normalizeCapabilityRow({
    id: "cap_1",
    slug: "hello",
    name: "Hello",
    keywords: '["demo"]',
    version: "3",
    enabled: "1"
  });
  assert.deepEqual(cap.keywords, ["demo"]);
  assert.equal(cap.version, 3);
  assert.equal(cap.enabled, true);
});

test("normalizeApprovalRow and normalizeArtifactRow map json + numbers", () => {
  const appr = normalizeApprovalRow({ id: "a1", run_id: "run_1", status: "pending", payload: '{"k":1}' });
  assert.equal(appr.runId, "run_1");
  assert.deepEqual(appr.payload, { k: 1 });

  const art = normalizeArtifactRow({ id: "art1", run_id: "run_1", size_bytes: "1024", metadata: "{}" });
  assert.equal(art.sizeBytes, 1024);
  assert.deepEqual(art.metadata, {});
});
