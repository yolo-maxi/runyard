import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  absoluteDeepLink,
  deepLinks,
  withAgentLinks,
  withArtifactLinks,
  withCapabilityLinks
} from "../src/deepLinks.js";

describe("deep link helpers", () => {
  it("builds encoded app hash routes", () => {
    assert.equal(deepLinks.run("run 1"), "/app#runs/run%201");
    assert.equal(deepLinks.runLogs("run/1"), "/app#runs/run%2F1/logs");
    assert.equal(deepLinks.workflowRun("deploy prod"), "/app#workflows/deploy%20prod/run");
    assert.equal(deepLinks.agent("pm/lead"), "/app#agents/agents/pm%2Flead");
    assert.equal(deepLinks.approval("appr_123"), "/app#approvals/appr_123");
  });

  it("links artifacts with and without run context", () => {
    assert.equal(deepLinks.artifact({ id: "art 1", runId: "run 1" }), "/app#runs/run%201/artifacts/art%201");
    assert.equal(deepLinks.artifact("art 1"), "/app#runs");
  });

  it("builds absolute links with fallback base handling", () => {
    assert.equal(absoluteDeepLink("/app#runs/run_1", "https://hub.example/base"), "https://hub.example/app#runs/run_1");
    assert.equal(absoluteDeepLink("/app#runs/run_1", "not a url/"), "not a url/app#runs/run_1");
  });

  it("decorates common API records with app links", () => {
    assert.deepEqual(withCapabilityLinks({ slug: "improve", name: "Improve" }), {
      slug: "improve",
      name: "Improve",
      deepLink: "/app#workflows/improve",
      deepLinkRuns: "/app#workflows/improve/runs",
      deepLinkEdit: "/app#workflows/improve/edit",
      deepLinkRun: "/app#workflows/improve/run"
    });
    assert.deepEqual(withAgentLinks({ slug: "pm" }), { slug: "pm", deepLink: "/app#agents/agents/pm" });
    assert.deepEqual(withArtifactLinks({ id: "art", runId: "run" }), {
      id: "art",
      runId: "run",
      deepLink: "/app#runs/run/artifacts/art",
      deepLinkRun: "/app#runs/run"
    });
  });
});
