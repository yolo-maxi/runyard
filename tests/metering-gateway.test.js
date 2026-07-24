import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  anthropicUsage,
  GATEWAY_OPENAI_PATH,
  GATEWAY_PI_PROVIDER,
  GATEWAY_TOKEN_ENV,
  gatewayMeteringIssues,
  gatewayRequestToken,
  gatewayRunToken,
  openAiUsage,
  runGatewayPin,
  sseUsage,
  verifyGatewayToken
} from "../src/meteringGateway.js";
import { createGatewayHandlers } from "../src/gatewayRoutes.js";
import {
  gatewayPinEnv,
  materializeGatewayPin,
  piGatewayModelsConfig
} from "../src/runnerGateway.js";
import { forwardSmithersEventTail, smithersTokenUsage } from "../src/runnerSmithersEvents.js";

const SECRET = "test-session-secret";

describe("gateway tokens", () => {
  it("mints and verifies per-run tokens", () => {
    const token = gatewayRunToken("run_abc123", SECRET);
    assert.match(token, /^ryg_run_abc123\./);
    assert.equal(verifyGatewayToken(token, SECRET), "run_abc123");
  });

  it("rejects tampered, foreign, and malformed tokens", () => {
    const token = gatewayRunToken("run_abc123", SECRET);
    assert.equal(verifyGatewayToken(token.replace("abc", "xyz"), SECRET), null);
    assert.equal(verifyGatewayToken(`${token}0`, SECRET), null);
    assert.equal(verifyGatewayToken(token, "other-secret"), null);
    assert.equal(verifyGatewayToken("ryg_norundot", SECRET), null);
    assert.equal(verifyGatewayToken("", SECRET), null);
    assert.equal(verifyGatewayToken(token, ""), null);
  });

  it("reads bearer and x-api-key credentials", () => {
    assert.equal(gatewayRequestToken({ headers: { authorization: "Bearer tok1" } }), "tok1");
    assert.equal(gatewayRequestToken({ headers: { "x-api-key": "tok2" } }), "tok2");
    assert.equal(gatewayRequestToken({ headers: {} }), "");
  });
});

describe("provider usage extraction", () => {
  it("parses openai-shaped responses including provider-reported cost", () => {
    const usage = openAiUsage({
      id: "chatcmpl-1",
      model: "llama-3.3-70b",
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0031 }
    });
    assert.equal(usage.promptTokens, 100);
    assert.equal(usage.totalTokens, 120);
    assert.equal(usage.costMicros, 3100);
    assert.equal(usage.requestId, "chatcmpl-1");
    assert.equal(openAiUsage({ usage: {} }), null);
    assert.equal(openAiUsage({}), null);
  });

  it("parses anthropic-shaped responses with cache metadata", () => {
    const usage = anthropicUsage({
      id: "msg_1",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 999 }
    });
    assert.equal(usage.totalTokens, 15);
    assert.equal(usage.metadata.cacheReadTokens, 999);
  });

  it("scans openai SSE streams for the include_usage final chunk", () => {
    const stream = [
      'data: {"id":"c1","model":"m1","choices":[{"delta":{"content":"hi"}}]}',
      'data: {"id":"c1","model":"m1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const usage = sseUsage(stream, "openai");
    assert.equal(usage.promptTokens, 7);
    assert.equal(usage.completionTokens, 3);
    assert.equal(usage.totalTokens, 10);
  });

  it("scans anthropic SSE streams via message_start/message_delta", () => {
    const stream = [
      'data: {"type":"message_start","message":{"id":"msg_2","model":"claude-sonnet-5","usage":{"input_tokens":40,"output_tokens":1}}}',
      'data: {"type":"content_block_delta","delta":{"text":"x"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":25}}',
      ""
    ].join("\n\n");
    const usage = sseUsage(stream, "anthropic");
    assert.equal(usage.promptTokens, 40);
    assert.equal(usage.completionTokens, 25);
    assert.equal(usage.model, "claude-sonnet-5");
  });

  it("returns null for streams without usage", () => {
    assert.equal(sseUsage('data: {"choices":[{"delta":{}}]}', "openai"), null);
    assert.equal(sseUsage("", "anthropic"), null);
  });
});

const GATEWAY_CAPABILITY = { slug: "research", workflow: {} };

function gatewayRun({ budget = null, usage = null, status = "running", input = {} } = {}) {
  return {
    id: "run_g1",
    capabilitySlug: "research",
    status,
    budget,
    usage,
    input: {
      agentHarness: "pi",
      metering: "gateway",
      piProvider: "venice",
      piModel: "llama-3.3-70b",
      piBaseUrl: "https://api.venice.example/v1",
      piApiKeyEnv: "VENICE_API_KEY",
      ...input
    }
  };
}

describe("runGatewayPin", () => {
  it("pins a complete gateway-metering pi selection and withholds the key", () => {
    const pin = runGatewayPin({ run: gatewayRun(), capability: GATEWAY_CAPABILITY, secret: SECRET });
    assert.equal(pin.path, GATEWAY_OPENAI_PATH);
    assert.equal(pin.provider, GATEWAY_PI_PROVIDER);
    assert.equal(pin.model, "llama-3.3-70b");
    assert.equal(pin.tokenEnv, GATEWAY_TOKEN_ENV);
    assert.equal(verifyGatewayToken(pin.token, SECRET), "run_g1");
    assert.deepEqual(pin.excludeSecretNames, ["VENICE_API_KEY"]);
  });

  it("does not pin without explicit gateway metering or with an incomplete selection", () => {
    const noMetering = gatewayRun();
    delete noMetering.input.metering;
    assert.equal(runGatewayPin({ run: noMetering, capability: GATEWAY_CAPABILITY, secret: SECRET }), null);

    const claude = gatewayRun({ input: { agentHarness: "claude" } });
    assert.equal(runGatewayPin({ run: claude, capability: GATEWAY_CAPABILITY, secret: SECRET }), null);

    const noKey = gatewayRun();
    delete noKey.input.piApiKeyEnv;
    assert.equal(runGatewayPin({ run: noKey, capability: GATEWAY_CAPABILITY, secret: SECRET }), null);

    assert.equal(runGatewayPin({ run: gatewayRun(), capability: GATEWAY_CAPABILITY, secret: "" }), null);
  });

  it("reports preflight blockers for incomplete gateway selections", () => {
    assert.deepEqual(gatewayMeteringIssues({ metering: "observed" }), []);
    assert.deepEqual(gatewayMeteringIssues({}), []);
    const issues = gatewayMeteringIssues({ metering: "gateway", agentHarness: "claude" });
    assert.ok(issues.length >= 3);
    assert.match(issues[0], /requires the pi harness/);
    const complete = gatewayMeteringIssues({
      metering: "gateway",
      agentHarness: "pi",
      piModel: "m",
      piBaseUrl: "https://x",
      piApiKeyEnv: "K"
    });
    assert.deepEqual(complete, []);
  });
});

function resStub() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    chunks: [],
    ended: false,
    status(code) { res.statusCode = code; return res; },
    set(name, value) { res.headers[String(name).toLowerCase()] = value; return res; },
    json(value) { res.body = value; res.ended = true; return res; },
    send(value) { res.body = value; res.ended = true; return res; },
    write(chunk) { res.chunks.push(Buffer.from(chunk).toString("utf8")); return true; },
    end() { res.ended = true; },
    flushHeaders() {}
  };
  return res;
}

function handlerHarness({ run = gatewayRun(), upstream, budgetOutcomes = [{ exceeded: false }, { exceeded: false }] } = {}) {
  const usageCalls = [];
  const budgetCalls = [];
  const fetchCalls = [];
  let budgetIndex = 0;
  const handlers = createGatewayHandlers({
    env: { sessionSecret: SECRET },
    processEnv: {},
    getRun: (id) => (id === run.id ? run : null),
    getCapability: () => GATEWAY_CAPABILITY,
    getDecryptedSecretEnv: (names) => (names.includes("VENICE_API_KEY") ? { VENICE_API_KEY: "sk-upstream" } : {}),
    recordRunUsage: (runId, body) => {
      usageCalls.push({ runId, body });
      return { ok: true, record: body, usage: {} };
    },
    enforceRunBudget: (target) => {
      budgetCalls.push(target);
      return budgetOutcomes[Math.min(budgetIndex++, budgetOutcomes.length - 1)];
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return upstream(url, options);
    },
    log: () => {}
  });
  return { handlers, usageCalls, budgetCalls, fetchCalls };
}

function jsonUpstream(body, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    text: async () => JSON.stringify(body)
  });
}

describe("gateway handlers", () => {
  const authedReq = (run, over = {}) => ({
    headers: { authorization: `Bearer ${gatewayRunToken(run.id, SECRET)}` },
    body: { model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }], stream: false },
    ...over
  });

  it("rejects missing/invalid tokens and inactive runs", async () => {
    const run = gatewayRun();
    const { handlers } = handlerHarness({ run });
    const res1 = resStub();
    await handlers.openAiChatCompletions({ headers: {}, body: {} }, res1);
    assert.equal(res1.statusCode, 401);

    const terminal = gatewayRun({ status: "budget_exceeded" });
    const { handlers: handlers2 } = handlerHarness({ run: terminal });
    const res2 = resStub();
    await handlers2.openAiChatCompletions(authedReq(terminal), res2);
    assert.equal(res2.statusCode, 403);
    assert.match(res2.body.error.message, /budget_exceeded/);
  });

  it("refuses to forward when the budget is already exhausted (no provider call)", async () => {
    const run = gatewayRun({ budget: { maxTokens: 10 }, usage: { totalTokens: 11 } });
    const { handlers, fetchCalls } = handlerHarness({
      run,
      budgetOutcomes: [{ exceeded: true, reason: "budget exceeded: 11 tokens used, budget.maxTokens is 10", stopped: true }],
      upstream: jsonUpstream({})
    });
    const res = resStub();
    await handlers.openAiChatCompletions(authedReq(run), res);
    assert.equal(res.statusCode, 402);
    assert.match(res.body.error.message, /budget exceeded/);
    assert.equal(fetchCalls.length, 0);
  });

  it("forwards to the run's selected upstream with the Hub-held key and records usage", async () => {
    const run = gatewayRun();
    const harness = handlerHarness({
      run,
      upstream: jsonUpstream({
        id: "chatcmpl-9",
        model: "llama-3.3-70b",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      })
    });
    const res = resStub();
    await harness.handlers.openAiChatCompletions(authedReq(run), res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).id, "chatcmpl-9");
    // Forwarded to the run's piBaseUrl with the decrypted hub-side key.
    assert.equal(harness.fetchCalls.length, 1);
    assert.equal(harness.fetchCalls[0].url, "https://api.venice.example/v1/chat/completions");
    assert.equal(harness.fetchCalls[0].options.headers.authorization, "Bearer sk-upstream");
    // Usage recorded at the inference boundary from the provider response.
    assert.equal(harness.usageCalls.length, 1);
    const recorded = harness.usageCalls[0];
    assert.equal(recorded.runId, "run_g1");
    assert.equal(recorded.body.promptTokens, 12);
    assert.equal(recorded.body.source, "gateway");
    assert.equal(recorded.body.provider, "venice");
    // Budget enforced before AND after the call.
    assert.equal(harness.budgetCalls.length, 2);
  });

  it("streams SSE through while capturing usage from the final chunk", async () => {
    const run = gatewayRun();
    const frames = [
      'data: {"id":"c2","model":"llama-3.3-70b","choices":[{"delta":{"content":"h"}}]}\n\n',
      'data: {"id":"c2","model":"llama-3.3-70b","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n"
    ];
    const harness = handlerHarness({
      run,
      upstream: async () => ({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/event-stream"]]),
        body: (async function* stream() {
          for (const frame of frames) yield Buffer.from(frame);
        })()
      })
    });
    const res = resStub();
    await harness.handlers.openAiChatCompletions(authedReq(run, { body: { model: "llama-3.3-70b", stream: true } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.chunks.join(""), frames.join(""));
    assert.equal(harness.usageCalls.length, 1);
    assert.equal(harness.usageCalls[0].body.totalTokens, 7);
  });

  it("fails closed with 502 when no upstream key is available", async () => {
    const run = gatewayRun();
    delete run.input.piApiKeyEnv;
    // Without piApiKeyEnv the pin would never be created, but the handler must
    // still fail closed if called.
    const harness = handlerHarness({ run, upstream: jsonUpstream({}) });
    harness.handlers; // silence lint-ish unused
    const res = resStub();
    await harness.handlers.openAiChatCompletions(authedReq(run), res);
    assert.equal(res.statusCode, 502);
    assert.equal(harness.fetchCalls.length, 0);
  });
});

describe("runner gateway pin materialization", () => {
  const gateway = {
    kind: "openai",
    path: GATEWAY_OPENAI_PATH,
    provider: GATEWAY_PI_PROVIDER,
    model: "llama-3.3-70b",
    tokenEnv: GATEWAY_TOKEN_ENV,
    token: "ryg_run_g1.abc",
    excludeSecretNames: ["VENICE_API_KEY"]
  };

  it("builds a single-provider pi models.json pointing at the hub", () => {
    const config = piGatewayModelsConfig(gateway, "https://hub.example/");
    const provider = config.providers[GATEWAY_PI_PROVIDER];
    assert.equal(provider.baseUrl, `https://hub.example${GATEWAY_OPENAI_PATH}`);
    assert.equal(provider.api, "openai-completions");
    // Key by $ENV reference only — the literal token must never be in the file.
    assert.equal(provider.apiKey, `$${GATEWAY_TOKEN_ENV}`);
    assert.equal(provider.models[0].id, "llama-3.3-70b");
    assert.equal(Object.keys(config.providers).length, 1);
  });

  it("materializes the per-run agent dir and returns pinned env", () => {
    const writes = [];
    const dirs = [];
    const env = materializeGatewayPin({
      workspace: "/work",
      runId: "run_g1",
      gateway,
      hubUrl: "https://hub.example",
      mkdir: (dir) => dirs.push(dir),
      writeFile: (file, content) => writes.push({ file, content })
    });
    assert.equal(dirs[0], "/work/.smithers/gateway/run_g1");
    assert.equal(writes[0].file, "/work/.smithers/gateway/run_g1/models.json");
    assert.ok(!writes[0].content.includes(gateway.token), "token must not be written to disk");
    assert.equal(env.PI_CODING_AGENT_DIR, "/work/.smithers/gateway/run_g1");
    assert.equal(env[GATEWAY_TOKEN_ENV], gateway.token);
    assert.equal(env.RUNYARD_RUN_AGENT_CLI, "pi");
    assert.equal(env.RUNYARD_RUN_PI_PROVIDER, GATEWAY_PI_PROVIDER);
    assert.equal(env.RUNYARD_RUN_PI_API_KEY_ENV, GATEWAY_TOKEN_ENV);
    assert.equal(env.RUNYARD_RUN_PI_BASE_URL, `https://hub.example${GATEWAY_OPENAI_PATH}`);
  });

  it("rejects incomplete gateway payloads", () => {
    assert.throws(() => materializeGatewayPin({
      workspace: "/work",
      runId: "run_g1",
      gateway: { path: GATEWAY_OPENAI_PATH },
      hubUrl: "https://hub.example",
      mkdir: () => {},
      writeFile: () => {}
    }), /incomplete/);
  });

  it("keeps env pin shape stable", () => {
    const env = gatewayPinEnv(gateway, { hubUrl: "https://hub.example", agentDir: "/dir" });
    assert.equal(env.PI_CODING_AGENT_DIR, "/dir");
  });
});

describe("smithersTokenUsage", () => {
  it("extracts a usage report from a real engine event line", () => {
    const line = JSON.stringify({
      runId: "run-1783359584696",
      seq: 18,
      timestampMs: 1783359620031,
      type: "TokenUsageReported",
      payload: {
        type: "TokenUsageReported",
        runId: "run-1783359584696",
        nodeId: "factory",
        iteration: 0,
        attempt: 1,
        model: "claude-opus-4-7",
        agent: "c7a7b946",
        inputTokens: 6,
        outputTokens: 1744,
        cacheReadTokens: 23163,
        timestampMs: 1783359620031
      }
    });
    const usage = smithersTokenUsage(line);
    assert.equal(usage.model, "claude-opus-4-7");
    assert.equal(usage.promptTokens, 6);
    assert.equal(usage.completionTokens, 1744);
    assert.equal(usage.source, "runner");
    assert.equal(usage.nodeId, "factory");
    assert.equal(usage.requestId, "run-1783359584696:18");
    assert.equal(usage.metadata.cacheReadTokens, 23163);
    assert.equal(usage.metadata.attempt, 1);
  });

  it("ignores non-usage lines, zero usage, and garbage", () => {
    assert.equal(smithersTokenUsage('{"type":"NodeStarted","runId":"r"}'), null);
    assert.equal(smithersTokenUsage("not json"), null);
    assert.equal(smithersTokenUsage(JSON.stringify({
      type: "TokenUsageReported",
      payload: { type: "TokenUsageReported", inputTokens: 0, outputTokens: 0 }
    })), null);
  });
});

describe("forwardSmithersEventTail", () => {
  const lifecycle = JSON.stringify({ runId: "engine-1", seq: 1, type: "NodeFinished" });
  const usage = JSON.stringify({
    runId: "engine-1",
    seq: 2,
    type: "TokenUsageReported",
    payload: {
      type: "TokenUsageReported",
      runId: "engine-1",
      nodeId: "hello",
      model: "claude-opus-4-7",
      inputTokens: 6,
      outputTokens: 66
    }
  });

  it("forwards only the unseen final suffix and meters terminal usage", async () => {
    const observed = [];
    const events = [];
    const usages = [];
    const lines = [JSON.stringify({ seq: 0, type: "NodeStarted" }), lifecycle, usage];

    const posted = await forwardSmithersEventTail({
      lines,
      posted: 1,
      observeEventLine: (line) => observed.push(line),
      postEventLine: async (line) => events.push(line),
      postUsage: async (record) => usages.push(record)
    });

    assert.equal(posted, 3);
    assert.deepEqual(observed, [lifecycle, usage]);
    assert.deepEqual(events, [lifecycle, usage]);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].requestId, "engine-1:2");
    assert.equal(usages[0].completionTokens, 66);
  });

  it("still forwards gateway events while suppressing duplicate gateway usage", async () => {
    const events = [];
    const usages = [];
    const posted = await forwardSmithersEventTail({
      lines: [usage],
      postEventLine: async (line) => events.push(line),
      postUsage: async (record) => usages.push(record),
      gatewayModel: "claude-opus-4-7"
    });

    assert.equal(posted, 1);
    assert.deepEqual(events, [usage]);
    assert.deepEqual(usages, []);
  });
});
