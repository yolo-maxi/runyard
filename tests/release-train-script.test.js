// End-to-end coverage for scripts/release-train.mjs against a throwaway git
// repo: status --json is parseable and truthful, gate/record write evidence
// keyed to HEAD, and a new commit stales old evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "release-train.mjs");

function run(cwd, args, { expectFail = false } = {}) {
  try {
    return execFileSync(process.execPath, [script, ...args, "--dir", cwd], { encoding: "utf8" });
  } catch (error) {
    if (expectFail) return error.stdout ?? "";
    throw error;
  }
}

function statusJson(cwd) {
  return JSON.parse(run(cwd, ["status", "--json"]));
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runyard-release-train-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  git("init", "-q", "-b", "runyard/v9.9.9-test");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Release Train Test");
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "fixture", version: "9.9.9" }, null, 2)}\n`);
  // Mirror the real repo: data/ (the evidence file's home) is gitignored, so
  // recording evidence must not dirty the tree.
  writeFileSync(path.join(dir, ".gitignore"), "data/\n");
  git("add", "package.json", ".gitignore");
  git("commit", "-q", "-m", "feat: fixture commit");
  return { dir, git };
}

test("release-train script: status, gates, evidence lifecycle", async (t) => {
  const { dir, git } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await t.test("fresh repo: clean tree, no evidence, next action is the first local gate", () => {
    const report = statusJson(dir);
    assert.equal(report.schema, "runyard.release-train.status/1");
    assert.equal(report.branch, "runyard/v9.9.9-test");
    assert.equal(report.trainVersion, "9.9.9");
    assert.equal(report.packageVersion, "9.9.9");
    assert.equal(report.headSha, git("rev-parse", "HEAD"));
    assert.equal(report.workingTree.dirty, false);
    assert.equal(report.base, null);
    assert.equal(report.upstream, null);
    assert.ok(report.gates.every((gate) => gate.status === "missing"));
    assert.equal(report.nextAction.id, "run-gate");
    assert.match(report.nextAction.summary, /"test"/);
    assert.deepEqual(report.blockers, []);
  });

  await t.test("dirty tree wins over gates", () => {
    writeFileSync(path.join(dir, "scratch.txt"), "wip\n");
    const report = statusJson(dir);
    assert.equal(report.workingTree.dirty, true);
    assert.equal(report.nextAction.id, "commit-or-stash");
    rmSync(path.join(dir, "scratch.txt"));
  });

  await t.test("gate <id> runs the command and records pass evidence at HEAD", () => {
    run(dir, ["gate", "diff-check"]);
    const report = statusJson(dir);
    const gate = report.gates.find((entry) => entry.id === "diff-check");
    assert.equal(gate.status, "pass");
    assert.equal(gate.evidenceHead, report.headSha);
  });

  await t.test("record --pass/--fail covers gates that ran elsewhere", () => {
    run(dir, ["record", "test", "--pass", "--note", "ran in host CI"]);
    run(dir, ["record", "build", "--pass"]);
    run(dir, ["record", "sandbox-smoke", "--fail", "--note", "actions run 42"]);
    const report = statusJson(dir);
    assert.equal(report.gates.find((entry) => entry.id === "test").note, "ran in host CI");
    assert.equal(report.gates.find((entry) => entry.id === "sandbox-smoke").status, "fail");
    assert.equal(report.nextAction.id, "fix-gate");
    assert.equal(report.ready, false);
    assert.match(report.blockers[0], /sandbox-smoke/);
  });

  await t.test("all gates green with no upstream: next action is push", () => {
    run(dir, ["record", "sandbox-smoke", "--pass", "--note", "actions run 43"]);
    const report = statusJson(dir);
    assert.ok(report.gates.every((gate) => gate.status === "pass"));
    assert.equal(report.nextAction.id, "push-branch");
    assert.equal(report.ready, false);
  });

  await t.test("a new commit stales all recorded evidence", () => {
    writeFileSync(path.join(dir, "next.txt"), "next slice\n");
    git("add", "next.txt");
    git("commit", "-q", "-m", "feat: next slice");
    const report = statusJson(dir);
    assert.ok(report.gates.every((gate) => gate.status === "stale"));
    assert.equal(report.nextAction.id, "run-gate");
  });

  await t.test("unknown gate and CI gate via `gate` are usage errors (exit 2)", () => {
    for (const gateId of ["nope", "sandbox-smoke"]) {
      assert.throws(
        () => execFileSync(process.execPath, [script, "gate", gateId, "--dir", dir], { encoding: "utf8", stdio: "pipe" }),
        (error) => error.status === 2
      );
    }
  });

  await t.test("human-readable status mentions branch, gates, and next command", () => {
    const text = run(dir, ["status"]);
    assert.match(text, /release-train: runyard\/v9\.9\.9-test @/);
    assert.match(text, /gates:/);
    assert.match(text, /next: run-gate/);
    assert.match(text, /\$ node scripts\/release-train\.mjs gate test/);
  });
});
