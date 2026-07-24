import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ciConcurrencyKey,
  ciConfigMatches,
  globToRegExp,
  matchesAnyGlob,
  parseCiConfig,
  validateJobDag
} from "../src/ciConfig.js";

const VALID = `
version: 1
name: ci
on:
  push:
    branches: [main]
    tags: ["v*"]
    paths: ["src/**", "tests/**"]
  pull_request:
    branches: [main]
concurrency:
  cancelInProgress: true
jobs:
  lint:
    executor: native
    commands: ["pnpm lint"]
    timeoutMinutes: 10
  test:
    executor: native
    needs: [lint]
    commands: ["pnpm install", "pnpm test"]
    env:
      NODE_ENV: test
    artifacts: ["coverage/**"]
  package:
    executor: dagger
    needs: [test]
    dagger:
      module: "."
      function: build
    required: false
`;

describe("ci.yml parsing", () => {
  it("accepts a full valid config and normalizes defaults", () => {
    const result = parseCiConfig(VALID);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const { config } = result;
    assert.equal(config.name, "ci");
    assert.equal(config.on.manual, true, "manual dispatch defaults on");
    assert.equal(config.concurrency.cancelInProgress, true);
    assert.deepEqual(config.jobs.map((j) => j.jobName), ["lint", "test", "package"]);
    const test = config.jobs.find((j) => j.jobName === "test");
    assert.equal(test.spec.timeoutMinutes, 30, "default timeout");
    assert.deepEqual(test.spec.env, { NODE_ENV: "test" });
    assert.equal(config.jobs.find((j) => j.jobName === "package").required, false);
  });

  it("rejects empty, oversized, malformed, and versionless configs", () => {
    assert.equal(parseCiConfig("").ok, false);
    assert.equal(parseCiConfig("just a string").ok, false);
    assert.equal(parseCiConfig("version: 2\non: {push: true}\njobs: {a: {commands: [x]}}").ok, false);
    assert.equal(parseCiConfig(`version: 1\non: {push: true}\njobs: {a: {commands: ["x"]}}\n# ${"p".repeat(130 * 1024)}`).ok, false);
    assert.match(parseCiConfig("version: [broken").errors[0], /invalid YAML/);
  });

  it("rejects unsafe paths: absolute, traversal, bad globs", () => {
    const bad = (jobExtra) =>
      parseCiConfig(`version: 1\non: {push: true}\njobs:\n  a:\n    commands: ["x"]\n    ${jobExtra}\n`);
    assert.equal(bad('workingDir: "/etc"').ok, false);
    assert.equal(bad('workingDir: "../up"').ok, false);
    assert.equal(bad('artifacts: ["/tmp/**"]').ok, false);
    assert.equal(bad('artifacts: ["a/../../b"]').ok, false);
  });

  it("rejects invalid job ids, env names, secret names, executors, timeouts", () => {
    const config = (jobs) => parseCiConfig(`version: 1\non: {push: true}\njobs:\n${jobs}`);
    assert.equal(config("  Bad_Job:\n    commands: ['x']\n").ok, false);
    assert.equal(config("  a:\n    commands: ['x']\n    env: {'lower': 'v'}\n").ok, false);
    assert.equal(config("  a:\n    commands: ['x']\n    secrets: ['lower']\n").ok, false);
    assert.equal(config("  a:\n    executor: kubernetes\n    commands: ['x']\n").ok, false);
    assert.equal(config("  a:\n    commands: ['x']\n    timeoutMinutes: 0\n").ok, false);
    assert.equal(config("  a:\n    commands: ['x']\n    timeoutMinutes: 9999\n").ok, false);
    assert.equal(config("  a:\n    executor: dagger\n    commands: ['x']\n").ok, false, "commands invalid for dagger");
    assert.equal(config("  a:\n    dagger: {function: f}\n").ok, false, "dagger block invalid for native");
  });

  it("validates the needs DAG: unknown refs, self-needs, cycles", () => {
    const config = (jobs) => parseCiConfig(`version: 1\non: {push: true}\njobs:\n${jobs}`);
    assert.match(config("  a:\n    commands: ['x']\n    needs: [ghost]\n").errors[0], /unknown job 'ghost'/);
    assert.match(config("  a:\n    commands: ['x']\n    needs: [a]\n").errors[0], /cannot need itself/);
    const cycle = config("  a:\n    commands: ['x']\n    needs: [b]\n  b:\n    commands: ['x']\n    needs: [a]\n");
    assert.match(cycle.errors[0], /cycle/);
    assert.deepEqual(validateJobDag([{ jobName: "a", needs: [] }]), []);
  });
});

describe("glob matching", () => {
  it("matches segment and cross-segment patterns deterministically", () => {
    assert.equal(globToRegExp("main").test("main"), true);
    assert.equal(globToRegExp("release/*").test("release/1.2"), true);
    assert.equal(globToRegExp("release/*").test("release/1/2"), false);
    assert.equal(globToRegExp("v*").test("v1.2.3"), true);
    assert.equal(globToRegExp("src/**").test("src/a/b/c.js"), true);
    assert.equal(globToRegExp("**/*.md").test("docs/a/readme.md"), true);
    assert.equal(globToRegExp("**/*.md").test("readme.md"), true);
    assert.equal(globToRegExp("a?c").test("abc"), true);
    assert.equal(globToRegExp("a?c").test("a/c"), false);
    assert.equal(matchesAnyGlob("src/x.js", ["docs/**", "src/**"]), true);
  });
});

describe("trigger matching", () => {
  const { config } = parseCiConfig(VALID);

  it("matches branch pushes against branch filters and path filters", () => {
    assert.equal(ciConfigMatches(config, { event: "push", ref: "refs/heads/main", changedPaths: ["src/db.js"] }).matched, true);
    assert.equal(ciConfigMatches(config, { event: "push", ref: "refs/heads/other", changedPaths: ["src/db.js"] }).matched, false);
    const noPathHit = ciConfigMatches(config, { event: "push", ref: "refs/heads/main", changedPaths: ["README.quirk"] });
    assert.equal(noPathHit.matched, false);
    assert.match(noPathHit.reason, /path/);
  });

  it("matches tag pushes against tag filters only", () => {
    assert.equal(ciConfigMatches(config, { event: "push", ref: "refs/tags/v1.0.0", changedPaths: [] }).matched, true);
    assert.equal(ciConfigMatches(config, { event: "push", ref: "refs/tags/nightly", changedPaths: [] }).matched, false);
  });

  it("matches pull requests by target branch and manual by config flag", () => {
    assert.equal(ciConfigMatches(config, { event: "pull_request", baseRef: "main" }).matched, true);
    assert.equal(ciConfigMatches(config, { event: "pull_request", baseRef: "release/2" }).matched, false);
    assert.equal(ciConfigMatches(config, { event: "manual" }).matched, true);
    const noManual = parseCiConfig("version: 1\non: {push: true, manual: false}\njobs: {a: {commands: ['x']}}").config;
    assert.equal(ciConfigMatches(noManual, { event: "manual" }).matched, false);
  });

  it("a tags-only push trigger ignores branch pushes", () => {
    const tagsOnly = parseCiConfig("version: 1\non: {push: {tags: ['v*']}}\njobs: {a: {commands: ['x']}}").config;
    assert.equal(ciConfigMatches(tagsOnly, { event: "push", ref: "refs/heads/main" }).matched, false);
    assert.equal(ciConfigMatches(tagsOnly, { event: "push", ref: "refs/tags/v2" }).matched, true);
  });
});

describe("concurrency keys", () => {
  const { config } = parseCiConfig(VALID);

  it("derives per-PR and per-ref keys, with literal group override", () => {
    assert.equal(
      ciConcurrencyKey({ repoFullName: "o/r", config, trigger: { event: "pull_request", prNumber: 7 } }),
      "o/r:pr/7"
    );
    assert.equal(
      ciConcurrencyKey({ repoFullName: "o/r", config, trigger: { event: "push", ref: "refs/heads/main" } }),
      "o/r:push/refs/heads/main"
    );
    const grouped = parseCiConfig(
      "version: 1\non: {push: true}\nconcurrency: {group: deploy}\njobs: {a: {commands: ['x']}}"
    ).config;
    assert.equal(ciConcurrencyKey({ repoFullName: "o/r", config: grouped, trigger: { event: "push", ref: "x" } }), "o/r:deploy");
  });
});

describe("review regressions (matching)", () => {
  it("path filters fail OPEN when the changed-file list is incomplete", () => {
    const { config } = parseCiConfig(VALID);
    const base = { event: "push", ref: "refs/heads/main", changedPaths: ["README.quirk"] };
    assert.equal(ciConfigMatches(config, base).matched, false, "complete list + no match -> skip");
    assert.equal(
      ciConfigMatches(config, { ...base, changedPathsTruncated: true }).matched,
      true,
      "truncated/forced list -> run CI rather than silently skip"
    );
  });
});
