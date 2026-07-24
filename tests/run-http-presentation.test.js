import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runOutputLinks, runStatusLinks } from "../src/runHttpPresentation.js";

describe("run HTTP presentation helpers", () => {
  it("builds common run status links", () => {
    assert.deepEqual(runStatusLinks("run 1"), {
      statusUrl: "/api/runs/run 1",
      eventsUrl: "/api/runs/run 1/events",
      eventsStreamUrl: "/api/runs/run 1/events/stream",
      webUrl: "/app#runs/run 1",
      deepLink: "/app#runs/run%201"
    });
  });

  it("adds output and artifact locations for queued run responses", () => {
    assert.deepEqual(runOutputLinks("run/1"), {
      statusUrl: "/api/runs/run/1",
      eventsUrl: "/api/runs/run/1/events",
      eventsStreamUrl: "/api/runs/run/1/events/stream",
      webUrl: "/app#runs/run/1",
      deepLink: "/app#runs/run%2F1",
      logsUrl: "/api/runs/run/1/logs",
      artifactsUrl: "/api/runs/run/1/artifacts",
      outputsLocation: "hub",
      artifactsLocation: "hub",
      deepLinkLogs: "/app#runs/run%2F1/logs",
      deepLinkArtifacts: "/app#runs/run%2F1/artifacts"
    });
  });
});
