import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { normalizeWorkflowKey, resolvePiEndpoint, resolveAgentCli, piAgentOptions, createPiAgentFromEnv } = await import(
  "../workflow-templates/workflows/pi-harness.js"
);

describe("pi harness endpoint config", () => {
  it("returns null when no Pi endpoint is configured", () => {
    assert.equal(resolvePiEndpoint({}), null);
    assert.equal(resolvePiEndpoint({ RUNYARD_PI_BASE_URL: "https://api.venice.ai/api/v1" }), null);
  });

  it("normalizes a Venice-style OpenAI-compatible endpoint", () => {
    const endpoint = resolvePiEndpoint({
      RUNYARD_PI_PROVIDER: " venice ",
      RUNYARD_PI_MODEL: "llama-3.3-70b",
      RUNYARD_PI_BASE_URL: "https://api.venice.ai/api/v1",
      RUNYARD_PI_API_KEY_ENV: "VENICE_API_KEY",
      VENICE_API_KEY: "vk-secret"
    });
    assert.deepEqual(endpoint, {
      provider: "venice",
      model: "llama-3.3-70b",
      baseUrl: "https://api.venice.ai/api/v1",
      apiKeyEnv: "VENICE_API_KEY",
      apiKeyConfigured: true
    });
  });

  it("reports a missing API key without exposing values", () => {
    const endpoint = resolvePiEndpoint({
      RUNYARD_PI_PROVIDER: "fugu",
      RUNYARD_PI_MODEL: "fugu-large",
      RUNYARD_PI_API_KEY_ENV: "FUGU_API_KEY"
    });
    assert.equal(endpoint.apiKeyConfigured, false);
    assert.equal("apiKey" in endpoint, false, "resolved config must never carry the key value");
  });

  it("applies per-workflow overrides on top of the global endpoint", () => {
    const env = {
      RUNYARD_PI_PROVIDER: "venice",
      RUNYARD_PI_MODEL: "llama-3.3-70b",
      RUNYARD_PI_API_KEY_ENV: "VENICE_API_KEY",
      RUNYARD_IMPLEMENT_PI_PROVIDER: "glm",
      RUNYARD_IMPLEMENT_PI_MODEL: "glm-4.7",
      RUNYARD_IMPLEMENT_PI_API_KEY_ENV: "ZAI_API_KEY"
    };
    const implementEndpoint = resolvePiEndpoint(env, { workflow: "IMPLEMENT" });
    assert.equal(implementEndpoint.provider, "glm");
    assert.equal(implementEndpoint.model, "glm-4.7");
    assert.equal(implementEndpoint.apiKeyEnv, "ZAI_API_KEY");
    const otherEndpoint = resolvePiEndpoint(env, { workflow: "IMPROVE" });
    assert.equal(otherEndpoint.provider, "venice");
  });

  it("normalizes workflow keys from slugs and labels", () => {
    assert.equal(normalizeWorkflowKey("gobbler-comic"), "GOBBLER_COMIC");
    assert.equal(normalizeWorkflowKey(" App Skinner "), "APP_SKINNER");
    assert.equal(normalizeWorkflowKey("IMPLEMENT"), "IMPLEMENT");
  });
});

describe("pi harness selection", () => {
  it("keeps the template default when nothing is configured", () => {
    assert.equal(resolveAgentCli({}, { workflow: "IMPLEMENT", fallback: "codex" }), "codex");
    assert.equal(resolveAgentCli({}, { workflow: "IMPROVE" }), "claude");
  });

  it("makes pi the default harness once an endpoint is configured", () => {
    const env = { RUNYARD_PI_PROVIDER: "fugu", RUNYARD_PI_MODEL: "fugu-large" };
    assert.equal(resolveAgentCli(env, { workflow: "IMPLEMENT", fallback: "codex" }), "pi");
  });

  it("lets explicit selection override the pi default, per workflow and globally", () => {
    const env = {
      RUNYARD_PI_PROVIDER: "fugu",
      RUNYARD_PI_MODEL: "fugu-large",
      RUNYARD_AGENT_CLI: "pi",
      RUNYARD_IMPLEMENT_AGENT_CLI: "Claude"
    };
    assert.equal(resolveAgentCli(env, { workflow: "IMPLEMENT", fallback: "codex" }), "claude");
    assert.equal(resolveAgentCli(env, { workflow: "IMPROVE" }), "pi");
  });
});

describe("pi agent construction", () => {
  it("builds Smithers-native PiAgent options without the API key in argv-visible options", () => {
    const endpoint = resolvePiEndpoint({
      RUNYARD_PI_PROVIDER: "glm",
      RUNYARD_PI_MODEL: "glm-4.7",
      RUNYARD_PI_API_KEY_ENV: "ZAI_API_KEY",
      ZAI_API_KEY: "zai-secret"
    });
    const options = piAgentOptions(endpoint, { cwd: "/repo", systemPrompt: "sp", timeoutMs: 1000 });
    assert.deepEqual(options, {
      provider: "glm",
      model: "glm-4.7",
      cwd: "/repo",
      systemPrompt: "sp",
      timeoutMs: 1000
    });
    assert.equal(JSON.stringify(options).includes("zai-secret"), false);
  });

  it("throws a clear error when pi is selected but unconfigured", () => {
    assert.throws(() => piAgentOptions(null), /RUNYARD_PI_PROVIDER/);
    assert.throws(
      () => createPiAgentFromEnv({ PiAgent: class {}, env: {}, workflow: "IMPLEMENT" }),
      /RUNYARD_PI_PROVIDER/
    );
    assert.throws(() => createPiAgentFromEnv({ env: {} }), /PiAgent constructor/);
  });

  it("constructs the injected PiAgent with the resolved endpoint", () => {
    class FakePiAgent {
      constructor(opts) {
        this.opts = opts;
        this.cliEngine = "pi";
      }
    }
    const agent = createPiAgentFromEnv({
      PiAgent: FakePiAgent,
      env: {
        RUNYARD_PI_PROVIDER: "venice",
        RUNYARD_PI_MODEL: "llama-3.3-70b",
        RUNYARD_PI_API_KEY_ENV: "VENICE_API_KEY"
      },
      workflow: "IMPROVE",
      cwd: "/repo",
      timeoutMs: 5000
    });
    assert.equal(agent.opts.provider, "venice");
    assert.equal(agent.opts.model, "llama-3.3-70b");
    assert.equal(agent.opts.cwd, "/repo");
    assert.equal(agent.opts.timeoutMs, 5000);
  });
});
