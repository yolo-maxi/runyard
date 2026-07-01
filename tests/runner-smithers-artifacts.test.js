import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectSmithersRunResult,
  smithersArtifactPayloads
} from "../src/runnerSmithersArtifacts.js";

describe("runner Smithers artifact helpers", () => {
  it("collects per-step outputs and full event trace", async () => {
    const calls = [];
    const result = await collectSmithersRunResult("run-1", {
      getState: async (sid) => {
        calls.push(["state", sid]);
        return { steps: [{ id: "a" }, { id: "b" }, { id: "c" }] };
      },
      nodeOutput: async (sid, nodeId) => {
        calls.push(["output", sid, nodeId]);
        return nodeId === "b" ? null : { value: nodeId };
      },
      fetchEvents: async (sid) => {
        calls.push(["events", sid]);
        return ["{\"message\":\"ok\"}"];
      }
    });

    assert.deepEqual(result.outputs, { a: { value: "a" }, c: { value: "c" } });
    assert.deepEqual(result.eventLines, ["{\"message\":\"ok\"}"]);
    assert.deepEqual(calls, [
      ["state", "run-1"],
      ["output", "run-1", "a"],
      ["output", "run-1", "b"],
      ["output", "run-1", "c"],
      ["events", "run-1"]
    ]);
  });

  it("builds output, markdown, and events artifact payloads", () => {
    const artifacts = smithersArtifactPayloads({
      sid: "run-1",
      state: "succeeded",
      outputs: {
        reportNode: {
          report: "# Report",
          artifactName: "report"
        }
      },
      eventLines: ["{\"data\":\"\\u001b[31merror\\u001b[0m\"}"]
    });

    assert.equal(artifacts[0].name, "smithers-output.json");
    assert.deepEqual(JSON.parse(artifacts[0].content).outputs.reportNode.report, "# Report");
    assert.equal(artifacts[1].name, "report.md");
    assert.equal(artifacts[1].metadata.sourceNode, "reportNode");
    assert.equal(artifacts[2].name, "smithers-events.ndjson");
    assert.equal(artifacts[2].content, "error");
  });
});
