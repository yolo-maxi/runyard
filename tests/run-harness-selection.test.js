import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveHarnessSelection, harnessSelectionRunEnv, harnessSelectionSecretNames } = await import(
  "../src/runHarnessSelection.js"
);
const { secretNamesForRun } = await import("../src/runnerAssignment.js");
const { resolveAgentCli, resolvePiEndpoint } = await import("../workflow-templates/workflows/pi-harness.js");
const { runyardChildEnv } = await import("../src/runnerSmithersRuntime.js");

describe("harness selection resolution", () => {
  it("resolves a full selection from run input", () => {
    const { selection, issues } = resolveHarnessSelection({
      input: {
        agentHarness: "pi",
        piProvider: "venice",
        piModel: "llama-3.3-70b",
        piBaseUrl: "https://api.venice.ai/api/v1",
        piApiKeyEnv: "VENICE_API_KEY"
      }
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(selection, {
      agentHarness: "pi",
      piProvider: "venice",
      piModel: "llama-3.3-70b",
      piBaseUrl: "https://api.venice.ai/api/v1",
      piApiKeyEnv: "VENICE_API_KEY"
    });
  });

  it("resolves from capability workflow config, with run input winning field-wise", () => {
    const capability = {
      workflow: { piProvider: "glm", piModel: "glm-4.7", piApiKeyEnv: "ZAI_API_KEY" }
    };
    const fromCapability = resolveHarnessSelection({ capability, input: {} });
    assert.deepEqual(fromCapability.selection, { piProvider: "glm", piModel: "glm-4.7", piApiKeyEnv: "ZAI_API_KEY" });

    const overridden = resolveHarnessSelection({
      capability,
      input: { piProvider: "venice", piModel: "llama-3.3-70b", piApiKeyEnv: "VENICE_API_KEY" }
    });
    assert.equal(overridden.selection.piProvider, "venice");
    assert.equal(overridden.selection.piApiKeyEnv, "VENICE_API_KEY");
  });

  it("returns an empty selection when nothing is selected", () => {
    assert.deepEqual(resolveHarnessSelection({}), { selection: {}, issues: [] });
    assert.deepEqual(resolveHarnessSelection({ capability: { workflow: {} }, input: { prompt: "hi" } }).selection, {});
  });

  it("rejects malformed fields without echoing the offending value", () => {
    const pastedKey = "vk-live-abc123-shhh";
    const { selection, issues } = resolveHarnessSelection({
      input: { agentHarness: "gpt", piApiKeyEnv: pastedKey, piBaseUrl: "not a url" }
    });
    assert.deepEqual(selection, {});
    assert.equal(issues.length, 3);
    for (const issue of issues) {
      assert.equal(issue.includes(pastedKey), false, "issue text must never carry the rejected value");
    }
    assert.match(issues.find((issue) => issue.includes('"piApiKeyEnv"')), /NAME/);
    assert.match(issues.find((issue) => issue.includes('"agentHarness"')), /"pi", "claude", "codex"/);
  });

  it("normalizes harness casing and trims whitespace", () => {
    const { selection, issues } = resolveHarnessSelection({ input: { agentHarness: " Claude ", piProvider: " fugu " } });
    assert.deepEqual(issues, []);
    assert.deepEqual(selection, { agentHarness: "claude", piProvider: "fugu" });
  });
});

describe("harness selection run env", () => {
  it("maps selection fields to RUNYARD_RUN_* names only", () => {
    const env = harnessSelectionRunEnv({
      agentHarness: "pi",
      piProvider: "venice",
      piModel: "llama-3.3-70b",
      piBaseUrl: "https://api.venice.ai/api/v1",
      piApiKeyEnv: "VENICE_API_KEY"
    });
    assert.deepEqual(env, {
      RUNYARD_RUN_AGENT_CLI: "pi",
      RUNYARD_RUN_PI_PROVIDER: "venice",
      RUNYARD_RUN_PI_MODEL: "llama-3.3-70b",
      RUNYARD_RUN_PI_BASE_URL: "https://api.venice.ai/api/v1",
      RUNYARD_RUN_PI_API_KEY_ENV: "VENICE_API_KEY"
    });
    assert.deepEqual(harnessSelectionRunEnv({}), {});
  });

  it("lets a run pick venice vs glm vs fugu without touching global env", () => {
    // Runner host env is configured once with a global default endpoint; the
    // per-run selection overrides it inside the child env.
    const runnerEnv = {
      RUNYARD_PI_PROVIDER: "fugu",
      RUNYARD_PI_MODEL: "fugu-large",
      RUNYARD_PI_API_KEY_ENV: "FUGU_API_KEY"
    };
    for (const [provider, model, keyEnv] of [
      ["venice", "llama-3.3-70b", "VENICE_API_KEY"],
      ["glm", "glm-4.7", "ZAI_API_KEY"],
      ["fugu", "fugu-large", "FUGU_API_KEY"]
    ]) {
      const { selection, issues } = resolveHarnessSelection({
        input: { piProvider: provider, piModel: model, piApiKeyEnv: keyEnv }
      });
      assert.deepEqual(issues, []);
      const childEnv = runyardChildEnv({
        baseEnv: runnerEnv,
        secretEnv: { [keyEnv]: `${provider}-secret` },
        runEnv: harnessSelectionRunEnv(selection)
      });
      const endpoint = resolvePiEndpoint(childEnv, { workflow: "IMPLEMENT" });
      assert.equal(endpoint.provider, provider);
      assert.equal(endpoint.model, model);
      assert.equal(endpoint.apiKeyEnv, keyEnv);
      assert.equal(endpoint.apiKeyConfigured, true);
      assert.equal(resolveAgentCli(childEnv, { workflow: "IMPLEMENT", fallback: "codex" }), "pi");
    }
    // The runner env itself was never edited.
    assert.equal(runnerEnv.RUNYARD_PI_PROVIDER, "fugu");
  });

  it("lets explicit claude/codex selection override the pi default per run", () => {
    const runnerEnv = {
      RUNYARD_PI_PROVIDER: "venice",
      RUNYARD_PI_MODEL: "llama-3.3-70b"
    };
    for (const harness of ["claude", "codex"]) {
      const { selection } = resolveHarnessSelection({ input: { agentHarness: harness } });
      const childEnv = runyardChildEnv({ baseEnv: runnerEnv, runEnv: harnessSelectionRunEnv(selection) });
      assert.equal(resolveAgentCli(childEnv, { workflow: "IMPLEMENT", fallback: "codex" }), harness);
    }
  });

  it('uses explicit agentHarness:"codex" as the PRODUCT workflow primary CLI', () => {
    const runnerEnv = {
      RUNYARD_PRODUCT_AGENT_CLI: "claude",
      RUNYARD_AGENT_CLI: "claude",
      RUNYARD_PI_PROVIDER: "venice",
      RUNYARD_PI_MODEL: "llama-3.3-70b"
    };
    const { selection, issues } = resolveHarnessSelection({ input: { agentHarness: "codex" } });
    assert.deepEqual(issues, []);
    const childEnv = runyardChildEnv({ baseEnv: runnerEnv, runEnv: harnessSelectionRunEnv(selection) });

    assert.equal(childEnv.RUNYARD_RUN_AGENT_CLI, "codex");
    assert.equal(resolveAgentCli(childEnv, { workflow: "PRODUCT", fallback: "claude" }), "codex");
  });
});

describe("harness selection secret delivery", () => {
  it("adds the selected key NAME to the run's secret names", () => {
    assert.deepEqual(harnessSelectionSecretNames({ piApiKeyEnv: "VENICE_API_KEY" }), ["VENICE_API_KEY"]);
    assert.deepEqual(harnessSelectionSecretNames({}), []);
  });

  it("merges workflow.secrets, input.secretNames, and the selection, deduped", () => {
    const capability = { workflow: { secrets: ["GITHUB_TOKEN"] } };
    const names = secretNamesForRun(capability, {
      secretNames: ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN"],
      piProvider: "glm",
      piModel: "glm-4.7",
      piApiKeyEnv: "ZAI_API_KEY"
    });
    assert.deepEqual(names.sort(), ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "ZAI_API_KEY"]);
  });

  it("supports storing all endpoint keys once and selecting per run", () => {
    // One capability, three runs: each run's selection pulls exactly the key
    // it names — the operator never re-lists keys or edits env between runs.
    const capability = { workflow: { secrets: [] } };
    const hubSecrets = {
      VENICE_API_KEY: "venice-secret",
      ZAI_API_KEY: "zai-secret",
      FUGU_API_KEY: "fugu-secret"
    };
    for (const keyEnv of Object.keys(hubSecrets)) {
      const names = secretNamesForRun(capability, { piApiKeyEnv: keyEnv });
      assert.deepEqual(names, [keyEnv]);
      const secretEnv = Object.fromEntries(names.filter((name) => name in hubSecrets).map((name) => [name, hubSecrets[name]]));
      assert.deepEqual(Object.keys(secretEnv), [keyEnv]);
    }
  });

  it("never lets a malformed selection add secret names", () => {
    const { selection } = resolveHarnessSelection({ input: { piApiKeyEnv: "vk-live-pasted-key" } });
    assert.deepEqual(harnessSelectionSecretNames(selection), []);
    assert.deepEqual(secretNamesForRun({ workflow: {} }, { piApiKeyEnv: "vk-live-pasted-key" }), []);
  });
});
