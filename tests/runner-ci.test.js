import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRunnerCi,
  expandArtifactGlobs,
  containedPath,
  isCiAssignment,
  runnerCiConfigFromEnv,
  sweepCiWorkspaces,
  validateCiCheckoutInput
} from "../src/runnerCi.js";

// Real git + real bash: the executor's checkout, merge-candidate, adapter,
// timeout, cancellation, and artifact paths are exercised against an actual
// local repository fixture (file:// clone via the explicit test seam).

let fixtureRoot;
let originUrl;
let shas;

function gitIn(dir, args, env = {}) {
  return execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...env
    },
    encoding: "utf8"
  }).trim();
}

before(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "runyard-ci-test-"));
  const origin = path.join(fixtureRoot, "origin");
  mkdirSync(origin);
  gitIn(origin, ["init", "-b", "main", "--quiet"]);
  writeFileSync(path.join(origin, "hello.txt"), "hello\n");
  writeFileSync(path.join(origin, "script.sh"), "echo from-repo\n");
  gitIn(origin, ["add", "."]);
  gitIn(origin, ["commit", "--quiet", "-m", "base"]);
  const baseSha = gitIn(origin, ["rev-parse", "HEAD"]);

  // Feature branch: adds a file (mergeable).
  gitIn(origin, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(path.join(origin, "feature.txt"), "feature\n");
  gitIn(origin, ["add", "."]);
  gitIn(origin, ["commit", "--quiet", "-m", "feature"]);
  const featureSha = gitIn(origin, ["rev-parse", "HEAD"]);

  // Conflicting branch: rewrites hello.txt...
  gitIn(origin, ["checkout", "--quiet", "main"]);
  gitIn(origin, ["checkout", "--quiet", "-b", "conflict"]);
  writeFileSync(path.join(origin, "hello.txt"), "conflict version\n");
  gitIn(origin, ["add", "."]);
  gitIn(origin, ["commit", "--quiet", "-m", "conflicting"]);
  const conflictSha = gitIn(origin, ["rev-parse", "HEAD"]);

  // ...while main moves ahead on the same file.
  gitIn(origin, ["checkout", "--quiet", "main"]);
  writeFileSync(path.join(origin, "hello.txt"), "mainline version\n");
  gitIn(origin, ["add", "."]);
  gitIn(origin, ["commit", "--quiet", "-m", "mainline"]);
  const mainSha = gitIn(origin, ["rev-parse", "HEAD"]);

  originUrl = `file://${origin}`;
  shas = { baseSha, featureSha, conflictSha, mainSha };
});

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function createHarness({ config = {}, clientOverrides = {} } = {}) {
  const posts = [];
  const events = [];
  const failures = [];
  let runStatus = "running";
  const client = {
    async post(pathname, body) {
      posts.push({ pathname, body });
      if (pathname.endsWith("/git-credential")) return { token: "" };
      return {};
    },
    async get() {
      return { run: { status: runStatus } };
    },
    ...clientOverrides
  };
  const runnerCi = createRunnerCi({
    workspace: path.join(fixtureRoot, "workspace"),
    runnerName: "test-runner",
    runnerId: "runner_test",
    client,
    event: async (runId, type, message, data = {}) => events.push({ runId, type, message, data }),
    failRun: async (runId, error, status) => failures.push({ runId, error, status }),
    config: {
      enabled: true,
      nativeAllowed: true,
      workDir: path.join(fixtureRoot, "ci-work"),
      retainFailedMs: 24 * 60 * 60_000,
      allowFileCloneUrls: true,
      ...config
    },
    baseEnv: process.env,
    log: () => {},
    logError: () => {}
  });
  return {
    runnerCi,
    posts,
    events,
    failures,
    setRunStatus: (status) => {
      runStatus = status;
    }
  };
}

function ciRun({ runId = `run_${Math.random().toString(16).slice(2, 10)}`, spec = {}, checkout = {}, executor = "native" } = {}) {
  return {
    id: runId,
    input: {
      __ci: {
        role: "job",
        pipelineId: "cipipe_1",
        pipelineName: "ci",
        jobId: "cijob_1",
        jobName: "test-job",
        repo: { provider: "github", fullName: "o/r", cloneUrl: originUrl, defaultBranch: "main" },
        checkout: { strategy: "head", headSha: shas.mainSha, ...checkout },
        executor,
        spec: { commands: ["echo hi"], timeoutMinutes: 5, ...spec },
        untrusted: false
      }
    }
  };
}

const CI_CAPABILITY = { slug: "ci-job", workflow: { engine: "runyard-ci" } };

describe("runner ci config + guards", () => {
  it("parses env config and never enables by default", () => {
    assert.equal(runnerCiConfigFromEnv({}).enabled, false);
    assert.equal(runnerCiConfigFromEnv({ RUNYARD_RUNNER_CI: "1" }).enabled, true);
    assert.equal(runnerCiConfigFromEnv({ RUNYARD_RUNNER_CI: "1" }).nativeAllowed, false);
    assert.equal(runnerCiConfigFromEnv({}).allowFileCloneUrls, undefined, "file clone urls are never env-enabled");
  });

  it("detects CI assignments and validates checkout input", () => {
    assert.equal(isCiAssignment(CI_CAPABILITY, {}), true);
    assert.equal(isCiAssignment({ workflow: { engine: "smithers" } }, { input: {} }), false);
    assert.match(validateCiCheckoutInput(null), /no __ci payload/);
    assert.match(validateCiCheckoutInput({ repo: { cloneUrl: "ssh://git@host/x" } }), /unsafe or missing clone url/);
    assert.match(
      validateCiCheckoutInput({ repo: { cloneUrl: "https://github.com/o/r.git" }, checkout: { strategy: "head", headSha: "short" } }),
      /full commit sha/
    );
    assert.equal(
      validateCiCheckoutInput({
        repo: { cloneUrl: "https://github.com/o/r.git" },
        checkout: { strategy: "head", headSha: "a".repeat(40) }
      }),
      ""
    );
    assert.match(validateCiCheckoutInput(ciRun().input.__ci), /unsafe/, "file:// rejected without the test seam");
    assert.equal(validateCiCheckoutInput(ciRun().input.__ci, { allowFileCloneUrls: true }), "");
  });

  it("path containment rejects escapes", () => {
    const root = path.join(fixtureRoot, "containment");
    mkdirSync(root, { recursive: true });
    assert.equal(containedPath(root, "sub/dir"), path.join(root, "sub/dir"));
    assert.equal(containedPath(root, "."), root);
    assert.throws(() => containedPath(root, "../outside"), /escapes/);
    assert.throws(() => containedPath(root, "/etc"), /escapes/);
  });

  it("refuses native execution unless the runner opted in", async () => {
    const h = createHarness({ config: { nativeAllowed: false } });
    const handled = await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run: ciRun(), secretEnv: {} });
    assert.equal(handled, true);
    assert.equal(h.failures[0].status, "blocked_by_preflight");
    assert.match(h.failures[0].error, /RUNYARD_RUNNER_CI_NATIVE/);
  });

  it("refuses everything when the runner is not CI-enabled", async () => {
    const h = createHarness({ config: { enabled: false } });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run: ciRun(), secretEnv: {} });
    assert.equal(h.failures[0].status, "blocked_by_preflight");
  });

  it("reports Dagger unavailability as a clear infrastructure error", async () => {
    const h = createHarness();
    // dagger is not installed on this box; the real probe finds nothing.
    const probe = await h.runnerCi.probeDagger();
    if (probe.available) return; // environment has dagger; skip the negative
    await h.runnerCi.handleCiRun({
      capability: CI_CAPABILITY,
      run: ciRun({ executor: "dagger", spec: { commands: undefined, dagger: { module: ".", function: "test", args: {} } } }),
      secretEnv: {}
    });
    assert.equal(h.failures[0].status, "infra_unavailable");
    assert.match(h.failures[0].error, /Dagger is not available/);
  });
});

describe("native adapter execution", () => {
  it("checks out the exact head sha, runs commands, uploads artifacts, completes, and cleans up", async () => {
    const h = createHarness();
    const run = ciRun({
      spec: {
        commands: ["cat hello.txt", "mkdir -p out", "echo result > out/result.txt", "test \"$RUNYARD_CI_SHA\" = \"$RUNYARD_CI_HEAD_SHA\""],
        artifacts: ["out/**"],
        env: {},
        timeoutMinutes: 5
      }
    });
    const handled = await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: { MY_SECRET: "s3cr3t" } });
    assert.equal(handled, true);
    assert.deepEqual(h.failures, []);

    const complete = h.posts.find((p) => p.pathname.endsWith("/complete"));
    assert.ok(complete, "complete was posted");
    assert.equal(complete.body.output.conclusion, "succeeded");
    assert.equal(complete.body.output.tested.testedSha, shas.mainSha);
    assert.ok(complete.body.output.tested.treeSha);
    assert.deepEqual(complete.body.output.artifacts, ["out/result.txt"]);

    const artifactPosts = h.posts.filter((p) => p.pathname.endsWith("/artifacts"));
    assert.equal(artifactPosts.length, 2, "glob artifact + job log");
    const globArtifact = artifactPosts.find((p) => p.body.metadata?.source === "ci-artifact-glob");
    assert.equal(Buffer.from(globArtifact.body.contentBase64, "base64").toString(), "result\n");
    const logArtifact = artifactPosts.find((p) => p.body.name === "ci-job-log.txt");
    assert.match(logArtifact.body.content, /mainline version/);

    const checkoutEvent = h.events.find((e) => e.type === "ci.job.checkout");
    assert.equal(checkoutEvent.data.testedSha, shas.mainSha);
    assert.equal(existsSync(path.join(fixtureRoot, "ci-work", run.id)), false, "successful workspace removed");
  });

  it("fails the run with the exit code and keeps the workspace as evidence", async () => {
    const h = createHarness();
    const run = ciRun({ spec: { commands: ["echo before", "false", "echo never"], timeoutMinutes: 5 } });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    assert.equal(h.failures.length, 1);
    assert.equal(h.failures[0].status, "failed");
    assert.match(h.failures[0].error, /exit code 1/);
    const workDir = path.join(fixtureRoot, "ci-work", run.id);
    assert.equal(existsSync(path.join(workDir, ".runyard-ci-failed")), true, "failed workspace retained with marker");
  });

  it("`set -e` semantics: later commands never run after a failure", async () => {
    const h = createHarness();
    const run = ciRun({ spec: { commands: ["false", "echo SHOULD_NOT_APPEAR"], timeoutMinutes: 5 } });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    const logArtifact = h.posts.find((p) => p.body?.name === "ci-job-log.txt");
    assert.ok(!/SHOULD_NOT_APPEAR/.test(logArtifact?.body?.content || ""));
  });

  it("delivers config env and secretEnv to the job but never the git credential", async () => {
    const h = createHarness({
      clientOverrides: {
        async post(pathname, body) {
          h.posts.push({ pathname, body });
          if (pathname.endsWith("/git-credential")) return { token: "ghs_supersecret" };
          return {};
        }
      }
    });
    // note: harness clientOverrides above capture into h.posts before h exists;
    // rebuild handler list from scratch instead.
    h.posts.length = 0;
    const run = ciRun({
      spec: {
        commands: ["env | sort > envdump.txt", "grep -q '^MY_VAR=42' envdump.txt", "! grep -q ghs_supersecret envdump.txt", "grep -q '^MY_SECRET=shh' envdump.txt"],
        env: { MY_VAR: "42" },
        artifacts: [],
        timeoutMinutes: 5
      }
    });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: { MY_SECRET: "shh" } });
    assert.deepEqual(h.failures, [], "env assertions inside the job all passed");
    assert.ok(h.posts.some((p) => p.pathname.endsWith("/complete")));
  });

  it("times out runaway jobs into timed_out with a dead process group", async () => {
    const h = createHarness();
    const run = ciRun({ spec: { commands: ["sleep 30"], timeoutMinutes: 0.005 } });
    const started = Date.now();
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    assert.ok(Date.now() - started < 15_000, "did not wait for the sleep");
    assert.equal(h.failures[0].status, "timed_out");
  });

  it("observes hub cancellation and stops without reporting terminal", async () => {
    const h = createHarness();
    const run = ciRun({ spec: { commands: ["sleep 30"], timeoutMinutes: 5 } });
    setTimeout(() => h.setRunStatus("cancelled"), 1500);
    const started = Date.now();
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    assert.ok(Date.now() - started < 20_000, "killed promptly after cancel observation");
    assert.deepEqual(h.failures, [], "no fail report for a hub-cancelled run");
    assert.ok(!h.posts.some((p) => p.pathname.endsWith("/complete")));
    assert.ok(h.events.some((e) => e.type === "runner.hub_terminal_observed"));
  });
});

describe("merge candidate construction", () => {
  it("builds the deterministic merge of head into base and reports its provenance", async () => {
    const h = createHarness();
    const run = ciRun({
      checkout: { strategy: "merge", headSha: shas.featureSha, baseSha: shas.mainSha },
      spec: { commands: ["test -f feature.txt", "grep -q mainline hello.txt"], timeoutMinutes: 5 }
    });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    assert.deepEqual(h.failures, [], "merged tree contains BOTH sides");
    const complete = h.posts.find((p) => p.pathname.endsWith("/complete"));
    assert.equal(complete.body.output.tested.strategy, "merge");
    assert.notEqual(complete.body.output.tested.testedSha, shas.featureSha, "tested sha is the merge, not the head");
    assert.equal(complete.body.output.tested.headSha, shas.featureSha);
    assert.equal(complete.body.output.tested.baseSha, shas.mainSha);
  });

  it("a conflicted merge candidate is a first-class blocked conclusion, never a silent head test", async () => {
    const h = createHarness();
    const run = ciRun({
      checkout: { strategy: "merge", headSha: shas.conflictSha, baseSha: shas.mainSha },
      spec: { commands: ["true"], timeoutMinutes: 5 }
    });
    await h.runnerCi.handleCiRun({ capability: CI_CAPABILITY, run, secretEnv: {} });
    assert.equal(h.failures.length, 1);
    assert.equal(h.failures[0].status, "blocked_by_preflight");
    assert.match(h.failures[0].error, /merge candidate/i);
    assert.ok(!h.posts.some((p) => p.pathname.endsWith("/complete")));
  });
});

describe("artifact globs + workspace hygiene", () => {
  it("expands globs inside the root only and skips symlinks", () => {
    const root = path.join(fixtureRoot, "globs");
    mkdirSync(path.join(root, "out/nested"), { recursive: true });
    writeFileSync(path.join(root, "out/a.txt"), "a");
    writeFileSync(path.join(root, "out/nested/b.txt"), "b");
    writeFileSync(path.join(root, "top.md"), "t");
    symlinkSync("/etc/hostname", path.join(root, "out/link.txt"));
    const found = expandArtifactGlobs(root, ["out/**", "*.md"]);
    assert.deepEqual(found.map((f) => f.relative).sort(), ["out/a.txt", "out/nested/b.txt", "top.md"]);
  });

  it("sweeps stale workspaces beyond retention", () => {
    const base = path.join(fixtureRoot, "sweep");
    mkdirSync(path.join(base, "old-run"), { recursive: true });
    mkdirSync(path.join(base, "fresh-run"), { recursive: true });
    const oldTime = (Date.now() - 48 * 60 * 60_000) / 1000;
    utimesSync(path.join(base, "old-run"), oldTime, oldTime);
    const removed = sweepCiWorkspaces(base, 24 * 60 * 60_000);
    assert.equal(removed, 1);
    assert.equal(existsSync(path.join(base, "old-run")), false);
    assert.equal(existsSync(path.join(base, "fresh-run")), true);
  });
});
