import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  artifactInsertQuery,
  artifactListQuery,
  artifactLookupQuery,
  artifactRecord,
  normalizeArtifact
} from "../src/operatorArtifactRecords.js";

describe("operator artifact record helpers", () => {
  it("builds and normalizes artifact records", () => {
    const record = artifactRecord({
      id: "art_1",
      runId: "run_1",
      name: "report.md",
      kind: "file",
      mimeType: "text/markdown",
      sizeBytes: 42,
      path: "/tmp/report.md",
      metadata: { source: "runner" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.metadata, '{"source":"runner"}');
    assert.deepEqual(normalizeArtifact(record), {
      id: "art_1",
      runId: "run_1",
      name: "report.md",
      kind: "file",
      mimeType: "text/markdown",
      sizeBytes: 42,
      path: "/tmp/report.md",
      metadata: { source: "runner" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("builds artifact list queries for run, search, and global views", () => {
    assert.deepEqual(artifactListQuery({ runId: "run_1" }), {
      sql: "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC",
      params: ["run_1"]
    });
    assert.deepEqual(artifactListQuery({ q: "report" }), {
      sql: "SELECT * FROM artifacts WHERE name LIKE ? OR metadata LIKE ? ORDER BY created_at DESC LIMIT 100",
      params: ["%report%", "%report%"]
    });
    assert.deepEqual(artifactListQuery(), {
      sql: "SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 100",
      params: []
    });
  });

  it("builds artifact insert and lookup queries", () => {
    assert.deepEqual(artifactInsertQuery(), {
      sql: `INSERT INTO artifacts (id, run_id, name, kind, mime_type, size_bytes, path, metadata, created_at)
     VALUES ($id, $run_id, $name, $kind, $mime_type, $size_bytes, $path, $metadata, $created_at)`
    });
    assert.deepEqual(artifactLookupQuery("art_1"), {
      sql: "SELECT * FROM artifacts WHERE id = ?",
      params: ["art_1"]
    });
  });
});
