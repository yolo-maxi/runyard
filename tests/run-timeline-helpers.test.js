import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  artifactTimelineKind,
  buildRunTimeline,
  timelinePage
} from "../src/runTimeline.js";
import { RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME } from "../src/runObstructionAnalysis.js";
import { RUN_RETROSPECTIVE_ARTIFACT_NAME } from "../src/runRetrospective.js";

describe("run timeline helpers", () => {
  it("classifies generated and runner artifacts consistently", () => {
    assert.deepEqual(artifactTimelineKind({ name: RUN_RETROSPECTIVE_ARTIFACT_NAME }), {
      kind: "retrospective",
      source: "artifacts:retrospective"
    });
    assert.deepEqual(artifactTimelineKind({ metadata: { kind: "run-obstruction-analysis" } }), {
      kind: "obstruction",
      source: "artifacts:obstruction"
    });
    assert.deepEqual(artifactTimelineKind({ name: RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME }), {
      kind: "obstruction",
      source: "artifacts:obstruction"
    });
    assert.deepEqual(artifactTimelineKind({ name: "result.md" }), {
      kind: "artifact",
      source: "artifacts:runner"
    });
  });

  it("builds a sorted timeline from status transitions, events, and artifacts", () => {
    const entries = buildRunTimeline({
      id: "run_1",
      status: "failed",
      currentStep: "failed",
      error: "boom",
      createdAt: "2026-06-30T00:00:00.000Z",
      startedAt: "2026-06-30T00:00:02.000Z",
      completedAt: "2026-06-30T00:00:04.000Z"
    }, {
      events: [{
        id: "evt_1",
        type: "log",
        message: "hello",
        data: { ok: true },
        createdAt: "2026-06-30T00:00:01.000Z"
      }],
      artifacts: [{
        id: "art_1",
        name: "result.md",
        mimeType: "text/markdown",
        sizeBytes: 10,
        metadata: { source: "runner" },
        createdAt: "2026-06-30T00:00:03.000Z"
      }],
      withArtifactLinks: (artifact) => ({ ...artifact, deepLink: `/artifact/${artifact.id}` })
    });

    assert.deepEqual(entries.map((entry) => entry.kind), ["status", "event", "status", "artifact", "status"]);
    assert.equal(entries[0].payload.transition, "created");
    assert.equal(entries.at(-1).payload.error, "boom");
    assert.equal(entries[3].payload.deepLink, "/artifact/art_1");
  });

  it("paginates without splitting timestamp ties", () => {
    const entries = [
      { ts: "2026-06-30T00:00:00.000Z", id: "a" },
      { ts: "2026-06-30T00:00:01.000Z", id: "b" },
      { ts: "2026-06-30T00:00:01.000Z", id: "c" },
      { ts: "2026-06-30T00:00:02.000Z", id: "d" }
    ];

    assert.deepEqual(timelinePage(entries, { limit: 2 }), {
      entries: [entries[0]],
      limit: 2,
      since: null,
      nextSince: entries[0].ts,
      truncated: true
    });
    assert.deepEqual(timelinePage(entries.slice(1), { limit: 1 }), {
      entries: [entries[1], entries[2]],
      limit: 1,
      since: null,
      nextSince: entries[2].ts,
      truncated: true
    });
  });
});
