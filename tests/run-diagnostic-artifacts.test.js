import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diagnosticArtifactScore,
  diagnosticArtifacts
} from "../src/runDiagnosticArtifacts.js";

describe("run diagnostic artifact helpers", () => {
  it("scores likely diagnostic artifacts", () => {
    assert.equal(diagnosticArtifactScore({ name: "stderr.log", mimeType: "text/x-log" }), 7);
    assert.equal(diagnosticArtifactScore({ name: "trace.txt", mimeType: "text/plain" }), 5);
    assert.equal(diagnosticArtifactScore({ name: "screenshot.png", mimeType: "image/png" }), 0);
  });

  it("selects and decorates the strongest diagnostic artifacts", () => {
    const selected = diagnosticArtifacts(
      [
        { id: "img", name: "screenshot.png", mimeType: "image/png", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "stderr", name: "stderr.log", mimeType: "text/x-log", createdAt: "2026-01-01T00:00:01.000Z" },
        { id: "trace", name: "trace.txt", mimeType: "text/plain", createdAt: "2026-01-01T00:00:02.000Z" }
      ],
      { withArtifactLinks: (artifact) => ({ ...artifact, linked: true }) }
    );

    assert.deepEqual(selected.map((artifact) => artifact.id), ["stderr", "trace"]);
    assert.equal(selected[0].linked, true);
  });
});
