import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { shouldFallbackAgent, isDeterministicAgentFailure, withAgentFallback, createAgentFallbackPair } = await import(
  "../workflow-templates/workflows/agent-fallback.js"
);

class FakeAgent {
  constructor(opts = {}) {
    this.opts = opts;
  }

  async generate() {
    return { text: this.constructor.name };
  }
}
class FakeClaude extends FakeAgent {}
class FakeCodex extends FakeAgent {}
class FakePi extends FakeAgent {
  constructor(opts = {}) {
    super(opts);
    this.cliEngine = "pi";
  }
}

describe("workflow agent fallback", () => {
  it("classifies auth, quota, rate-limit, and refusal errors as fallbackable", () => {
    for (const message of [
      "Claude run failed: 429 rate_limit",
      "You've hit your monthly spend limit",
      "token_invalidated",
      "401 unauthorized",
      "model refusal"
    ]) {
      assert.equal(shouldFallbackAgent(new Error(message)), true, message);
    }
  });

  it("does not fallback for deterministic native structured-output schema errors", () => {
    for (const message of [
      "api_error_status 400: Invalid schema for response_format: additionalProperties must be false",
      "structured output schema validation failed: object requires additionalProperties:false",
      "JSON schema is invalid for native structured output",
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_json_schema",
          message:
            "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.",
          param: "text.format.schema"
        },
        status: 400
      })
    ]) {
      assert.equal(shouldFallbackAgent(new Error(message)), false, message);
      assert.equal(isDeterministicAgentFailure(new Error(message)), true, message);
    }
  });

  it("does not fallback for ordinary implementation errors", () => {
    assert.equal(shouldFallbackAgent(new Error("TypeError: cannot read property of undefined")), false);
    assert.equal(isDeterministicAgentFailure(new Error("documentation authoring failed")), false);
    assert.equal(isDeterministicAgentFailure(new Error("request expired before execution")), false);
  });

  it("tries the fallback agent once and clears CLI-specific resume state", async () => {
    const calls = [];
    const primary = {
      cliEngine: "claude-code",
      async generate() {
        calls.push("primary");
        throw new Error("429 rate limit");
      }
    };
    const fallback = {
      cliEngine: "codex",
      async generate(options) {
        calls.push(["fallback", options.resumeSession, options.lastHeartbeat]);
        return { text: "ok" };
      }
    };
    const agent = withAgentFallback(primary, fallback, { label: "test" });
    const result = await agent.generate({
      resumeSession: "claude-session",
      lastHeartbeat: { provider: "claude" },
      onStderr: () => {}
    });
    assert.deepEqual(calls, ["primary", ["fallback", undefined, undefined]]);
    assert.deepEqual(result, { text: "ok" });
  });

  it("does not fallback for non-fallbackable errors", async () => {
    const agent = withAgentFallback(
      {
        cliEngine: "codex",
        async generate() {
          throw new Error("syntax error in generated code");
        }
      },
      {
        cliEngine: "claude-code",
        async generate() {
          throw new Error("should not run");
        }
      }
    );
    await assert.rejects(() => agent.generate(), /syntax error/);
  });

  it("surfaces native schema errors without touching an expired fallback provider", async () => {
    const calls = [];
    const agent = withAgentFallback(
      {
        cliEngine: "codex",
        async generate() {
          calls.push("codex");
          throw new Error("api_error_status 400: Invalid schema: additionalProperties must be false");
        }
      },
      {
        cliEngine: "claude-code",
        async generate() {
          calls.push("claude");
          throw new Error("Claude authentication expired");
        }
      },
      { label: "product-workflow-researcher" }
    );
    await assert.rejects(() => agent.generate(), /additionalProperties/);
    assert.deepEqual(calls, ["codex"]);
  });

  it("does not invoke providers again when Smithers retries a deterministic schema failure", async () => {
    const calls = [];
    const agent = withAgentFallback(
      {
        cliEngine: "codex",
        async generate() {
          calls.push("codex");
          throw new Error("api_error_status 400: Invalid schema: additionalProperties must be false");
        }
      },
      {
        cliEngine: "claude-code",
        async generate() {
          calls.push("claude");
          throw new Error("should not run");
        }
      },
      { label: "product-workflow-researcher" }
    );
    await assert.rejects(() => agent.generate(), /additionalProperties/);
    await assert.rejects(() => agent.generate(), /additionalProperties/);
    assert.deepEqual(calls, ["codex"]);
  });

  it("does not invoke providers again when Smithers retries a deterministic auth/schema pair", async () => {
    const calls = [];
    const agent = withAgentFallback(
      {
        cliEngine: "claude-code",
        async generate() {
          calls.push("claude");
          throw new Error("Claude authentication expired");
        }
      },
      {
        cliEngine: "codex",
        async generate() {
          calls.push("codex");
          throw new Error("api_error_status 400: Invalid schema for response_format: additionalProperties must be false");
        }
      },
      { label: "product-workflow-strategist" }
    );
    await assert.rejects(() => agent.generate(), /deterministic provider\/config failures/);
    await assert.rejects(() => agent.generate(), /deterministic provider\/config failures/);
    assert.deepEqual(calls, ["claude", "codex"]);
  });

  it("leaves transient provider failures retryable by Smithers", async () => {
    const calls = [];
    const agent = withAgentFallback(
      {
        cliEngine: "codex",
        async generate() {
          calls.push("codex");
          throw new Error("429 rate_limit");
        }
      },
      {
        cliEngine: "claude-code",
        async generate() {
          calls.push("claude");
          throw new Error("503 upstream overloaded");
        }
      },
      { label: "transient-test" }
    );
    await assert.rejects(() => agent.generate(), /503 upstream overloaded/);
    await assert.rejects(() => agent.generate(), /503 upstream overloaded/);
    assert.deepEqual(calls, ["codex", "claude", "codex", "claude"]);
  });

  it("classifies a missing CLI binary (ENOENT spawn failure) as fallbackable", () => {
    assert.equal(shouldFallbackAgent(new Error("spawn pi ENOENT")), true);
  });

  it("puts PiAgent first when the pi harness is selected, degrading to the CLI pair", async () => {
    const env = {
      RUNYARD_PI_PROVIDER: "venice",
      RUNYARD_PI_MODEL: "llama-3.3-70b",
      RUNYARD_PI_API_KEY_ENV: "VENICE_API_KEY",
      VENICE_API_KEY: "vk-secret"
    };
    const agent = createAgentFallbackPair({
      ClaudeCodeAgent: FakeClaude,
      CodexAgent: FakeCodex,
      PiAgent: FakePi,
      primaryCli: "pi",
      workflow: "IMPROVE",
      env,
      label: "pi-test",
      cwd: "/repo",
      claude: { systemPrompt: "sp", timeoutMs: 1000 }
    });
    assert.match(agent.cliEngine, /^pi\+fallback:/);
    assert.deepEqual(await agent.generate({}), { text: "FakePi" });
  });

  it("degrades to the CLI pair when the selected endpoint key was never delivered", async () => {
    const stderr = [];
    const agent = createAgentFallbackPair({
      ClaudeCodeAgent: FakeClaude,
      CodexAgent: FakeCodex,
      PiAgent: FakePi,
      primaryCli: "pi",
      workflow: "IMPROVE",
      env: {
        RUNYARD_PI_PROVIDER: "venice",
        RUNYARD_PI_MODEL: "llama-3.3-70b",
        RUNYARD_PI_API_KEY_ENV: "VENICE_API_KEY"
        // VENICE_API_KEY missing: not in workflow.secrets / secretNames / selection.
      }
    });
    assert.deepEqual(await agent.generate({ onStderr: (line) => stderr.push(line) }), { text: "FakeClaude" });
    assert.equal(stderr.join("").includes("VENICE_API_KEY"), true, "degradation reason names the key env");
  });

  it("falls back from a failing pi endpoint to the CLI pair", async () => {
    class FailingPi extends FakePi {
      async generate() {
        throw new Error("401 unauthorized from custom endpoint");
      }
    }
    const agent = createAgentFallbackPair({
      ClaudeCodeAgent: FakeClaude,
      CodexAgent: FakeCodex,
      PiAgent: FailingPi,
      primaryCli: "pi",
      workflow: "IMPROVE",
      env: { RUNYARD_PI_PROVIDER: "fugu", RUNYARD_PI_MODEL: "fugu-large" }
    });
    assert.deepEqual(await agent.generate({}), { text: "FakeClaude" });
  });

  it("builds PiAgent with the endpoint config and no API key material", () => {
    let seen = null;
    class CapturingPi extends FakePi {
      constructor(opts) {
        super(opts);
        seen = opts;
      }
    }
    createAgentFallbackPair({
      ClaudeCodeAgent: FakeClaude,
      CodexAgent: FakeCodex,
      PiAgent: CapturingPi,
      primaryCli: "pi",
      workflow: "IMPLEMENT",
      env: {
        RUNYARD_IMPLEMENT_PI_PROVIDER: "glm",
        RUNYARD_IMPLEMENT_PI_MODEL: "glm-4.7",
        RUNYARD_IMPLEMENT_PI_API_KEY_ENV: "ZAI_API_KEY",
        ZAI_API_KEY: "zai-secret"
      },
      cwd: "/repo"
    });
    assert.equal(seen.provider, "glm");
    assert.equal(seen.model, "glm-4.7");
    assert.equal(seen.cwd, "/repo");
    assert.equal(JSON.stringify(seen).includes("zai-secret"), false);
  });

  it("throws when the pi harness is selected without an endpoint config", () => {
    assert.throws(
      () =>
        createAgentFallbackPair({
          ClaudeCodeAgent: FakeClaude,
          CodexAgent: FakeCodex,
          PiAgent: FakePi,
          primaryCli: "pi",
          env: {}
        }),
      /RUNYARD_PI_PROVIDER/
    );
  });

  it("keeps claude/codex pairs unchanged when pi is not selected", async () => {
    const agent = createAgentFallbackPair({
      ClaudeCodeAgent: FakeClaude,
      CodexAgent: FakeCodex,
      primaryCli: "codex",
      env: {}
    });
    assert.deepEqual(await agent.generate({}), { text: "FakeCodex" });
  });

  it("ships fallback wiring in agent-backed workflow templates", () => {
    for (const file of [
      "idea-to-product.tsx",
      "implement.tsx",
      "implement-change-gated.tsx",
      "improve.tsx",
      "runyard-support-agent.tsx",
      "smart-contract-audit.tsx"
    ]) {
      const src = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", file), "utf8");
      assert.match(src, /agent-fallback\.js|withAgentFallback|createAgentFallbackPair/, file);
      assert.match(src, /CodexAgent/, file);
      assert.match(src, /ClaudeCodeAgent/, file);
      assert.match(src, /PiAgent/, file);
      assert.match(src, /resolveAgentCli/, file);
    }
  });

  it("keeps improve output schemas compatible with Codex structured output", () => {
    const src = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "improve.tsx"), "utf8");
    assert.doesNotMatch(src, /z\.looseObject/, "Codex rejects loose structured-output schemas");
  });
});
