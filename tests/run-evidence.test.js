import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  artifactInventory,
  highlightEvents,
  msBetween,
  safeArtifactMetadata,
  safeNumber,
  topEventTypes,
  valueShape
} from "../src/runEvidence.js";

describe("run evidence helpers", () => {
  it("computes durations and value shapes without exposing values", () => {
    assert.equal(msBetween("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.000Z"), 3000);
    assert.equal(msBetween("bad", "2026-01-01T00:00:03.000Z"), null);
    assert.equal(safeNumber("42"), 42);
    assert.equal(safeNumber("bad", 7), 7);
    assert.deepEqual(valueShape({ token: "secret", nested: { value: 1 } }).fields.nested, {
      type: "object",
      keys: ["value"],
      fields: {}
    });
  });

  it("builds artifact inventory with safe metadata and configurable transforms", () => {
    const inventory = artifactInventory([
      { name: "generated.json" },
      {
        id: "art_1",
        name: "result.md",
        mimeType: "text/markdown",
        sizeBytes: "12",
        metadata: { generatedBy: "runner", token: "secret" }
      }
    ], {
      generatedNames: ["generated.json"],
      transform: (value) => String(value).toUpperCase()
    });

    assert.deepEqual(inventory, [{
      id: "art_1",
      name: "RESULT.MD",
      mimeType: "TEXT/MARKDOWN",
      sizeBytes: 12,
      createdAt: "",
      deepLink: "",
      metadata: { GENERATEDBY: "RUNNER" }
    }]);
    assert.deepEqual(safeArtifactMetadata(null), {});
  });

  it("normalizes event type and highlight lists", () => {
    const summary = {
      types: [{ key: "stderr", count: "2", category: "log" }],
      highlights: [{ id: "evt_1", type: "run.failed", category: "run", severity: "error", node: "build", message: "failed" }]
    };

    assert.deepEqual(topEventTypes(summary, { count: Number }), [{ key: "stderr", count: 2, category: "log" }]);
    assert.deepEqual(highlightEvents(summary, { includeId: false }), [{
      type: "run.failed",
      category: "run",
      severity: "error",
      node: "build",
      message: "failed",
      createdAt: ""
    }]);
  });
});
