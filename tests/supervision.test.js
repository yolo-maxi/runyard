import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-supervision-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_supervision_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
const { getRun, transitionRun } = await import("../src/db.js");
const {
  decideSupervision,
  capabilityDefaultsToSupervision,
  buildSupervisorInput,
  stripSupervisionInternals,
  readSupervisionBypass
} = await import("../src/supervision.js");
const { buildRepoCatalog } = await import("../src/repoCatalog.js");

let server;
let baseUrl;
const token = "shub_supervision_token";

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("supervision decision (pure)", () => {
  it("supervises Smithers workflow capabilities by default, never the wrapper itself", () => {
    assert.equal(capabilityDefaultsToSupervision({ slug: "improve", supervision: { default: true } }), true);
    assert.equal(capabilityDefaultsToSupervision({ slug: "research", workflow: { engine: "smithers" } }), true);
    assert.equal(capabilityDefaultsToSupervision({ slug: "research", workflow: { engine: "smithers" }, supervision: { default: false } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "internal-tool", workflow: { engine: "smithers" }, supervision: { internal: true } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "external", workflow: { engine: "http" } }), false);
    // The wrapper is never wrapped even if mislabeled.
    assert.equal(capabilityDefaultsToSupervision({ slug: "run-smithers", supervision: { default: true } }), false);
  });

  it("decides wrap vs direct, with the wrapper as the recursion base case", () => {
    const improve = { slug: "improve", supervision: { default: true } };
    const research = { slug: "research", workflow: { engine: "smithers" } };
    assert.equal(decideSupervision(improve, { target: "x" }, {}).action, "wrap");
    assert.equal(decideSupervision(research, { prompt: "x" }, {}).action, "wrap");
    assert.equal(decideSupervision({ slug: "run-smithers" }, {}, {}).action, "direct");
    assert.equal(decideSupervision({ slug: "internal", workflow: { engine: "smithers" }, supervision: { default: false } }, {}, {}).action, "direct");
  });

  it("honors a valid bypass marker but ignores a forged/stale one", () => {
    const improve = { slug: "improve", supervision: { default: true } };
    const findSupervisorByToken = (tok, cap) =>
      tok === "good" && cap === "improve" ? { id: "run-parent", status: "running" } : null;

    const valid = decideSupervision(improve, { target: "x", __supervisedChild: { token: "good" } }, { findSupervisorByToken });
    assert.equal(valid.action, "direct");
    assert.equal(valid.parentRunId, "run-parent");

    // Forged token -> no matching supervisor -> falls through to wrap.
    const forged = decideSupervision(improve, { target: "x", __supervisedChild: { token: "bad" } }, { findSupervisorByToken });
    assert.equal(forged.action, "wrap");

    // Stale (terminal) parent -> wrap again rather than skip supervision.
    const terminalLookup = () => ({ id: "run-parent", status: "succeeded" });
    const stale = decideSupervision(improve, { target: "x", __supervisedChild: { token: "good" } }, { findSupervisorByToken: terminalLookup });
    assert.equal(stale.action, "wrap");
  });

  it("buildSupervisorInput nests the user input and strips internals on read", () => {
    const built = buildSupervisorInput({
      capability: { slug: "improve", name: "Improve" },
      input: { target: "x", __supervisedChild: { token: "t" } },
      goal: "make it nicer",
      token: "sup_abc"
    });
    assert.equal(built.wrappedCapability, "improve");
    assert.equal(built.wrappedInput.target, "x");
    assert.equal(built.wrappedInput.__supervisedChild, undefined);
    assert.equal(built.__supervisionToken, "sup_abc");
    assert.equal(readSupervisionBypass({ __supervisedChild: { token: "t" } }).token, "t");
    assert.equal(stripSupervisionInternals({ a: 1, __supervisionToken: "x" }).__supervisionToken, undefined);
  });
});

describe("supervision envelope over the API", () => {
  it("wraps normal UI-startable capabilities, hiding the bypass token", async () => {
    for (const [slug, input] of [
      ["improve", { target: "polish" }],
      ["idea-to-product", { idea: "tiny app" }],
      ["research", { prompt: "tiny research" }],
      ["implement-change-gated", { workPrompt: "tiny change", deploy: false, repo: "smithers-hub" }]
    ]) {
      const created = await api(`/api/capabilities/${slug}/run`, { method: "POST", body: { input } });
      assert.equal(created.run.capabilitySlug, slug, `${slug} should stay visible as the requested workflow`);
      assert.equal(created.run.actualCapabilitySlug, "run-smithers", `${slug} should still be executed by the supervisor`);
      assert.equal(created.supervising.wrappedCapability, slug);
      assert.equal(created.run.supervision.wrappedCapability, slug);
      assert.deepEqual(created.run.input, input);
      assert.equal(created.run.input.wrappedCapability, undefined);
      assert.equal(created.run.input.wrappedInput, undefined);
      // Token redacted from the API response...
      assert.equal(created.run.input.__supervisionToken, undefined);
      // ...but present on the raw stored run so the runner can echo it.
      const raw = getRun(created.run.id);
      assert.equal(raw.capabilitySlug, "run-smithers");
      assert.equal(raw.input.wrappedCapability, slug);
      assert.match(raw.input.__supervisionToken, /^sup_/);
    }
  });

  it("never wraps the run-smithers wrapper itself", async () => {
    const created = await api("/api/capabilities/run-smithers/run", {
      method: "POST",
      body: { input: { wrappedCapability: "research", wrappedInput: { prompt: "hi" }, goal: "g" } }
    });
    assert.equal(created.run.capabilitySlug, "run-smithers");
    assert.equal(created.supervising, undefined);
  });

  it("dispatches a verified supervised child directly, preventing infinite wrapping", async () => {
    // 1. User asks for improve -> a supervising run-smithers run is created.
    const parent = await api("/api/capabilities/improve/run", { method: "POST", body: { input: { target: "child-test" } } });
    assert.equal(parent.run.capabilitySlug, "improve");
    assert.equal(parent.run.actualCapabilitySlug, "run-smithers");
    // 2. The runner (run-smithers workflow) reads the token from the raw run.
    const supervisionToken = getRun(parent.run.id).input.__supervisionToken;
    assert.ok(supervisionToken, "supervisor run must carry an internal token");
    // 3. The child spawn carries the bypass marker — it must NOT be re-wrapped.
    const child = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "child-test", __supervisedChild: { token: supervisionToken } } }
    });
    assert.equal(child.run.capabilitySlug, "improve", "supervised child must run improve directly");
    assert.equal(child.supervisedChild.parentRunId, parent.run.id);
    assert.equal(child.run.input.__supervisedChild, undefined, "bypass marker must be stripped from stored input");
    // Lineage: child origin points back at the supervising run.
    assert.equal(child.run.origin?.parentRunId, parent.run.id);
  });

  it("ignores a forged bypass token from a public caller (still wraps)", async () => {
    const forged = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "forge", __supervisedChild: { token: "sup_not_a_real_token" } } }
    });
    assert.equal(forged.run.capabilitySlug, "improve", "forged request should still present as the requested workflow");
    assert.equal(forged.run.actualCapabilitySlug, "run-smithers", "a forged token must not skip supervision");
  });

  it("presents supervised child output instead of the supervisor envelope output", async () => {
    const parent = await api("/api/capabilities/research/run", {
      method: "POST",
      body: { input: { prompt: "short question" } }
    });
    const supervisionToken = getRun(parent.run.id).input.__supervisionToken;
    const child = await api("/api/capabilities/research/run", {
      method: "POST",
      body: { input: { prompt: "short question", __supervisedChild: { token: supervisionToken } } }
    });
    transitionRun(child.run.id, "running");
    transitionRun(child.run.id, "succeeded", {
      output: { answer: "child answer" },
      completed_at: new Date().toISOString()
    });
    transitionRun(parent.run.id, "running");
    transitionRun(parent.run.id, "succeeded", {
      output: {
        smithersRunId: "run-smithers-workflow-id",
        outputs: {
          supervise: {
            outcome: "succeeded",
            wrapped_run_id: child.run.id,
            lineage: JSON.stringify([{ runId: child.run.id, status: "succeeded" }])
          }
        }
      },
      completed_at: new Date().toISOString()
    });

    const detail = await api(`/api/runs/${parent.run.id}`);
    assert.equal(detail.run.capabilitySlug, "research");
    assert.equal(detail.run.actualCapabilitySlug, "run-smithers");
    assert.deepEqual(detail.run.input, { prompt: "short question" });
    assert.deepEqual(detail.run.output, { answer: "child answer" });
    assert.equal(detail.run.supervision.supervisorRunId, parent.run.id);
    assert.equal(detail.run.supervision.childRunId, child.run.id);
    assert.equal(detail.run.supervision.outcome, "succeeded");
  });
});

describe("repo options endpoint", () => {
  const repoEnvKeys = ["IMPROVE_REPO_MAP", "IMPROVE_PROJECT_MAP", "SMITHERS_REPO_CATALOG"];
  function withRepoEnv(overrides, fn) {
    const prev = Object.fromEntries(repoEnvKeys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, overrides);
    return Promise.resolve(fn()).finally(() => {
      for (const k of repoEnvKeys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
  }

  it("returns the default Hub repo and configured keys without leaking paths or secrets", async () => {
    await withRepoEnv(
      {
        IMPROVE_REPO_MAP: JSON.stringify({ docs: "/srv/secret/runner/path/docs" }),
        IMPROVE_PROJECT_MAP: JSON.stringify({ runyard: "/srv/secret/runner/path/runyard" }),
        SMITHERS_REPO_CATALOG: JSON.stringify([{ value: "marketing", label: "Marketing site" }])
      },
      async () => {
        const data = await api("/api/repo-options");
        const values = data.options.map((o) => o.value);
        assert.ok(values.includes("smithers-hub"), "default Hub repo must be present");
        assert.ok(values.includes("docs"));
        assert.ok(values.includes("runyard"));
        assert.ok(values.includes("marketing"));
        // Friendly keys only — no absolute runner-local paths anywhere in the body.
        const serialized = JSON.stringify(data);
        assert.equal(/\/srv\/secret\/runner\/path/.test(serialized), false, "raw paths must not be exposed");
        assert.equal(data.default.value, "smithers-hub");
        // repoDir stays an escape hatch but carries a clear warning.
        assert.match(data.repoDir.warning, /runner-local/);
      }
    );
  });

  it("ignores malformed catalog env instead of failing", () => {
    const catalog = buildRepoCatalog({ IMPROVE_REPO_MAP: "{not json", SMITHERS_REPO_CATALOG: "also bad" });
    assert.equal(catalog.options[0].value, "smithers-hub");
  });
});

describe("run form repo picker (UI source)", () => {
  it("ships repo picker + search wiring and keeps the raw JSON fallback", () => {
    const src = readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
    assert.match(src, /data-repo-selector/);
    assert.match(src, /hydrateRepoPickers/);
    assert.match(src, /\/api\/repo-options/);
    assert.match(src, /<datalist/);
    assert.match(src, /Edit &amp; re-run/);
    assert.match(src, /RERUN_DRAFT_KEY/);
    assert.match(src, /Re-run with edited input/);
    // Raw JSON escape hatch must still exist.
    assert.match(src, /Edit as raw JSON instead/);
  });
});

describe("implement-change-gated repo selector contract", () => {
  it("declares repo picker fields in the seeded input schema", async () => {
    const { capability } = await api("/api/capabilities/implement-change-gated");
    assert.equal(capability.inputSchema.properties.repo.type, "string");
    assert.equal(capability.inputSchema.properties.project.type, "string");
    assert.equal(capability.inputSchema.properties.repoDir.type, "string");
  });
});
