import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-supervision-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_supervision_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
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
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

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
  it("does not carry an independent default supervisor poll deadline", () => {
    const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "run-smithers.tsx"), "utf8");
    assert.match(source, /process\.env\.SMITHERS_RUN_DEADLINE_MS/);
    // The supervise task carries no timeoutMs at all: it may legitimately block
    // for as long as a human approval stays pending, so any local task deadline
    // would turn a late approver into a failed run. Containment lives in hub
    // liveness plus the approval-aware runner deadline.
    assert.doesNotMatch(source, /<Task id="supervise"[^>]*timeoutMs/);
    assert.doesNotMatch(source, /60 \* 60 \* 1000/);
  });

  it("does not supervise Smithers workflow capabilities by default", () => {
    assert.equal(capabilityDefaultsToSupervision({ slug: "improve", supervision: { default: true } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "research", workflow: { engine: "smithers" } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "research", workflow: { engine: "smithers" }, supervision: { default: false } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "internal-tool", workflow: { engine: "smithers" }, supervision: { internal: true } }), false);
    assert.equal(capabilityDefaultsToSupervision({ slug: "external", workflow: { engine: "http" } }), false);
    // The wrapper is never wrapped even if mislabeled.
    assert.equal(capabilityDefaultsToSupervision({ slug: "run-smithers", supervision: { default: true } }), false);
  });

  it("decides direct dispatch, with the wrapper as the recursion base case", () => {
    const improve = { slug: "improve", supervision: { default: true } };
    const research = { slug: "research", workflow: { engine: "smithers" } };
    assert.equal(decideSupervision(improve, { target: "x" }, {}).action, "direct");
    assert.equal(decideSupervision(research, { prompt: "x" }, {}).action, "direct");
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

    // Forged token -> no matching supervisor -> direct dispatch.
    const forged = decideSupervision(improve, { target: "x", __supervisedChild: { token: "bad" } }, { findSupervisorByToken });
    assert.equal(forged.action, "direct");

    // Stale (terminal) parent -> direct dispatch.
    const terminalLookup = () => ({ id: "run-parent", status: "succeeded" });
    const stale = decideSupervision(improve, { target: "x", __supervisedChild: { token: "good" } }, { findSupervisorByToken: terminalLookup });
    assert.equal(stale.action, "direct");
  });

  it("allows a verified run-smithers repair child to dispatch implement-change-gated directly", () => {
    const gated = { slug: "implement-change-gated", workflow: { engine: "smithers" } };
    const findSupervisorByToken = (tok, cap) =>
      tok === "good" && cap === "" ? { id: "run-parent", status: "running" } : null;

    const repair = decideSupervision(
      gated,
      { workPrompt: "fix workflow", __supervisedChild: { token: "good", purpose: "repair" } },
      { findSupervisorByToken }
    );
    assert.equal(repair.action, "direct");
    assert.equal(repair.parentRunId, "run-parent");

    const forged = decideSupervision(
      gated,
      { workPrompt: "fix workflow", __supervisedChild: { token: "bad", purpose: "repair" } },
      { findSupervisorByToken }
    );
    assert.equal(forged.action, "direct");
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
    assert.equal(readSupervisionBypass({ __supervisedChild: { token: "t", purpose: "repair" } }).purpose, "repair");
    assert.equal(stripSupervisionInternals({ a: 1, __supervisionToken: "x" }).__supervisionToken, undefined);
  });
});

describe("retired supervision envelope over the API", () => {
  it("runs normal UI-startable capabilities directly", async () => {
    for (const [slug, input] of [
      ["improve", { target: "polish" }],
      ["idea-to-product", { idea: "tiny app" }],
      ["research", { prompt: "tiny research" }],
      ["implement-change-gated", { workPrompt: "tiny change", deploy: false, repo: "smithers-hub" }]
    ]) {
      const created = await api(`/api/capabilities/${slug}/run`, { method: "POST", body: { input } });
      assert.equal(created.run.capabilitySlug, slug, `${slug} should stay visible as the requested workflow`);
      assert.equal(created.run.actualCapabilitySlug, undefined, `${slug} should execute directly with no hidden wrapper`);
      assert.equal(created.supervising, undefined);
      assert.equal(created.run.supervision, undefined);
      for (const [key, value] of Object.entries(input)) {
        assert.deepEqual(created.run.input[key], value);
      }
      assert.equal(created.run.input.wrappedCapability, undefined);
      assert.equal(created.run.input.wrappedInput, undefined);
      assert.equal(created.run.input.__supervisionToken, undefined);
    }
  });

  it("strips forged bypass internals instead of wrapping", async () => {
    const forged = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "forge", __supervisedChild: { token: "sup_not_a_real_token" } } }
    });
    assert.equal(forged.run.capabilitySlug, "improve");
    assert.equal(forged.run.actualCapabilitySlug, undefined);
    assert.equal(forged.run.input.__supervisedChild, undefined);
    assert.equal(forged.supervising, undefined);
  });

  it("routes reruns directly through the requested workflow", async () => {
    const first = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "rerun target", repo: "smithers-hub" } }
    });
    const rerun = await api(`/api/runs/${first.run.id}/rerun`, {
      method: "POST",
      body: { input: { target: "rerun target edited", repo: "smithers-hub" } }
    });
    assert.equal(rerun.run.capabilitySlug, "improve");
    assert.equal(rerun.run.actualCapabilitySlug, undefined);
    assert.equal(rerun.supervising, undefined);
    assert.equal(rerun.run.input.target, "rerun target edited");
    assert.equal(rerun.run.input.repo, "smithers-hub");
    assert.equal(rerun.run.input.rerunOf, first.run.id);
  });

  it("dedupes duplicate active reruns of direct workflows", async () => {
    const first = await api("/api/capabilities/improve/run", {
      method: "POST",
      body: { input: { target: "dedupe rerun target", repo: "runyard" } }
    });
    const input = { target: "dedupe rerun target edited", repo: "runyard" };
    const rerun = await api(`/api/runs/${first.run.id}/rerun`, {
      method: "POST",
      body: { input }
    });
    const duplicate = await api(`/api/runs/${first.run.id}/rerun`, {
      method: "POST",
      body: { input }
    });

    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.run.id, rerun.run.id);
    assert.equal(duplicate.run.actualCapabilitySlug, undefined);
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
        assert.ok(values.includes("runyard"), "default Hub repo must be present");
        assert.ok(values.includes("docs"));
        assert.ok(values.includes("marketing"));
        // Friendly keys only — no absolute runner-local paths anywhere in the body.
        const serialized = JSON.stringify(data);
        assert.equal(/\/srv\/secret\/runner\/path/.test(serialized), false, "raw paths must not be exposed");
        assert.equal(data.default.value, "runyard");
        // repoDir stays an escape hatch but carries a clear warning.
        assert.match(data.repoDir.warning, /runner-local/);
      }
    );
  });

  it("ignores malformed catalog env instead of failing", () => {
    const catalog = buildRepoCatalog({ IMPROVE_REPO_MAP: "{not json", SMITHERS_REPO_CATALOG: "also bad" });
    assert.equal(catalog.options[0].value, "runyard");
  });
});

describe("run form repo picker (UI source)", () => {
  it("ships repo picker + search wiring and keeps the raw JSON fallback", () => {
    // After the React rewrite the run form lives in web/components/RunForm.jsx,
    // the edit-rerun draft key in web/lib/runActions.js, and the run card's
    // "Edit & re-run" action in web/components/RunCard.jsx.
    const runForm = readFileSync(path.join(process.cwd(), "web", "components", "RunForm.jsx"), "utf8");
    const runActions = readFileSync(path.join(process.cwd(), "web", "lib", "runActions.js"), "utf8");
    const runCard = readFileSync(path.join(process.cwd(), "web", "components", "RunCard.jsx"), "utf8");

    // Repo/project picker wiring: the datalist-backed selector hydrated from
    // /api/repo-options (replaces the legacy hydrateRepoPickers internal).
    assert.match(runForm, /data-repo-selector/);
    assert.match(runForm, /\/api\/repo-options/);
    assert.match(runForm, /<datalist/);
    // Edit-rerun flow: the submit button label and the draft storage key.
    assert.match(runForm, /Re-run with edited input/);
    assert.match(runActions, /RERUN_DRAFT_KEY/);
    // The run card still exposes the "Edit & re-run" action. After the UI
    // density pass it lives as an OverflowMenu (⋯) item — a plain JS string
    // label, so the ampersand is no longer JSX-escaped.
    assert.match(runCard, /Edit & re-run/);
    assert.match(runCard, /OverflowMenu/);
    // Raw JSON escape hatch must still exist.
    assert.match(runForm, /Edit as raw JSON instead/);
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
