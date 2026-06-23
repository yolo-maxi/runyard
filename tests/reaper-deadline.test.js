import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp DB so created capabilities/runs don't pollute count-based
// assertions in the shared api.test.js suite.
const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-reaper-"));
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");

const { createRun, getCapability, getRun, reapStuckRunIds, updateRun, upsertCapability } = await import("../src/db.js");

describe("reaper deadline resolution", () => {
  it("respects a capability's own max_run_minutes over the global default", () => {
    upsertCapability({
      slug: "reaper-long",
      name: "Reaper Long",
      workflow: { engine: "smithers", entry: ".smithers/workflows/noop.tsx" },
      maxRunMinutes: 180
    });
    const cap = getCapability("reaper-long");
    const run = createRun(cap, { goal: "long" }, {});
    const longAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    updateRun(run.id, { status: "running", started_at: longAgo, assigned_at: longAgo });

    const reaped = reapStuckRunIds(30 * 60_000);
    assert.equal(reaped.includes(run.id), false, "180m window should outlast a 40m runtime");
    assert.equal(getRun(run.id).status, "running");
  });

  it("lets a supervised run inherit the wrapped capability's deadline, not the run-smithers wrapper's", () => {
    // The real work opts into a long window; the run-smithers wrapper has none.
    upsertCapability({
      slug: "wrapped-audit",
      name: "Wrapped Audit",
      workflow: { engine: "smithers", entry: ".smithers/workflows/noop.tsx" },
      maxRunMinutes: 180
    });
    const wrapper = getCapability("run-smithers") || upsertCapability({
      slug: "run-smithers",
      name: "run-smithers (supervising wrapper)",
      workflow: { engine: "smithers", entry: ".smithers/workflows/run-smithers.tsx" }
    });
    const control = upsertCapability({
      slug: "reaper-control",
      name: "Reaper Control",
      workflow: { engine: "smithers", entry: ".smithers/workflows/noop.tsx" }
    });

    // Supervised run executes under the wrapper capability; the wrapped slug
    // only lives in the run input envelope (buildSupervisorInput).
    const supervised = createRun(getCapability("run-smithers") || wrapper, {
      wrappedCapability: "wrapped-audit",
      wrappedInput: {},
      goal: "Supervise Wrapped Audit"
    }, {});
    const plain = createRun(control, { goal: "control" }, {});

    // Both started 40 minutes ago — past the 30m default, inside the 180m window.
    const longAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    for (const id of [supervised.id, plain.id]) {
      updateRun(id, { status: "running", started_at: longAgo, assigned_at: longAgo });
    }

    const reaped = reapStuckRunIds(30 * 60_000);
    assert.equal(reaped.includes(supervised.id), false, "supervised audit should inherit the 180m wrapped deadline");
    assert.equal(reaped.includes(plain.id), true, "a run with no deadline should still hit the 30m default");
    assert.equal(getRun(supervised.id).status, "running");
    assert.equal(getRun(plain.id).status, "failed");
  });
});
