import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capabilityRunDispatchOptions,
  capabilityRunInput,
  capabilityRunResponse,
  prepareCapabilityRunRequest,
  registerRunResponseEndpoint
} from "../src/capabilityRun.js";

describe("capability run helpers", () => {
  it("sanitizes response endpoints from fallback run input", () => {
    const input = capabilityRunInput({ goal: "ship", responseEndpoint: { type: "http" } });
    assert.deepEqual(input, { goal: "ship" });
  });

  it("builds dispatch options with resolved capability version metadata", () => {
    const options = capabilityRunDispatchOptions({
      body: { parentRunId: "run_parent", pin: "abc1234", runnerId: "runner_1" },
      capability: { slug: "hello" },
      env: { RUNYARD_CAPABILITY_VERSIONING: "1" },
      execution: { mode: "local" },
      origin: {
        requestedBy: "operator",
        origin: { source: "test" }
      }
    });

    assert.deepEqual(options, {
      runnerId: "runner_1",
      requestedBy: "operator",
      origin: { source: "test" },
      execution: { mode: "local" },
      capabilitySha: "abc1234",
      parentRunId: "run_parent"
    });
  });

  it("prepares input, chain, execution, origin, and dispatch options", () => {
    const req = {
      body: {
        input: { goal: "ship" },
        chain: ["next"],
        executionMode: "local",
        pin: "abc123"
      },
      headers: {},
      token: { name: "operator" }
    };

    const prepared = prepareCapabilityRunRequest({
      req,
      capability: { slug: "hello" },
      env: { RUNYARD_CAPABILITY_VERSIONING: "1" }
    });

    assert.equal(prepared.input.goal, "ship");
    assert.deepEqual(prepared.input.__chain, [{ capability: "next", input: {} }]);
    assert.equal(prepared.execution.mode, "local");
    assert.equal(prepared.origin.requestedBy, "token: operator");
    assert.equal(prepared.dispatchOptions.capabilitySha, "abc123");
  });

  it("registers response endpoints with event and audit side effects", () => {
    const events = [];
    const audits = [];
    const responseEndpoint = registerRunResponseEndpoint({
      addRunEvent: (...args) => events.push(args),
      createRunResponseEndpoint: (input) => ({
        id: "endpoint_1",
        runId: input.runId,
        type: input.type,
        config: input.config
      }),
      origin: { requestedBy: "operator" },
      recordAudit: (...args) => audits.push(args),
      responseEndpoint: { type: "http", config: { url: "https://example.test", headers: { Authorization: "secret" } } },
      run: { id: "run_1" },
      token: { name: "operator" }
    });

    assert.equal(responseEndpoint.id, "endpoint_1");
    assert.equal(events[0][1], "run.response_endpoint.registered");
    assert.equal(audits[0][1], "run.response_endpoint.registered");
    assert.equal(JSON.stringify(audits[0]).includes("secret"), false);
  });

  it("builds capability run responses with optional supervision and endpoint data", () => {
    const payload = capabilityRunResponse({
      dispatched: { supervising: { wrappedCapability: "hello" } },
      registeredResponseEndpoint: { id: "endpoint_1" },
      run: { id: "run_1" },
      withRunLinks: (run) => ({ ...run, linked: true })
    });

    assert.deepEqual(payload.run, { id: "run_1", linked: true });
    assert.deepEqual(payload.supervising, { wrappedCapability: "hello" });
    assert.deepEqual(payload.responseEndpoint, { id: "endpoint_1" });
    assert.equal(payload.statusUrl, "/api/runs/run_1");
    assert.equal(payload.artifactsUrl, "/api/runs/run_1/artifacts");
    assert.equal(payload.deepLink, "/app#runs/run_1");
  });
});
