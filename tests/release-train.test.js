import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_GATES,
  buildReleaseTrainReport,
  evaluateGate,
  findReleaseGate,
  parseTrainVersion,
  renderReleaseTrainText
} from "../src/releaseTrain.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function facts(overrides = {}) {
  return {
    generatedAt: "2026-07-03T00:00:00.000Z",
    branch: "runyard/v0.6.0-fable",
    headSha: HEAD,
    headShort: HEAD.slice(0, 7),
    headSubject: "feat: something",
    packageVersion: "0.3.1",
    tagsAtHead: [],
    dirtyFiles: 0,
    baseRef: "origin/main",
    baseAhead: 2,
    baseBehind: 0,
    upstreamRef: "origin/runyard/v0.6.0-fable",
    upstreamAhead: 0,
    upstreamBehind: 0,
    evidenceFile: "/tmp/evidence.json",
    ...overrides
  };
}

function passEntry(head = HEAD) {
  return { head, result: "pass", recordedAt: "2026-07-03T00:00:00.000Z", note: null };
}

function allGreenEvidence() {
  return Object.fromEntries(RELEASE_GATES.map((gate) => [gate.id, passEntry()]));
}

test("parseTrainVersion reads the train version from the branch name", () => {
  assert.equal(parseTrainVersion("runyard/v0.6.0-fable"), "0.6.0");
  assert.equal(parseTrainVersion("runyard/v1.2.3"), "1.2.3");
  assert.equal(parseTrainVersion("runyard/v0.6.0rc1"), "");
  assert.equal(parseTrainVersion("main"), "");
  assert.equal(parseTrainVersion(""), "");
  assert.equal(parseTrainVersion(null), "");
});

test("gate registry has the four release gates and sandbox-smoke is CI-only", () => {
  assert.deepEqual(RELEASE_GATES.map((gate) => gate.id), ["test", "build", "diff-check", "sandbox-smoke"]);
  assert.equal(findReleaseGate("sandbox-smoke").kind, "ci");
  assert.equal(findReleaseGate("sandbox-smoke").command, null);
  assert.equal(findReleaseGate("nope"), null);
  for (const gate of RELEASE_GATES.filter((entry) => entry.kind === "local")) {
    assert.ok(Array.isArray(gate.command) && gate.command.length > 0, `${gate.id} has a runnable command`);
  }
});

test("evaluateGate: missing, pass, fail, and stale evidence", () => {
  const gate = findReleaseGate("test");
  assert.equal(evaluateGate(gate, undefined, HEAD).status, "missing");
  assert.equal(evaluateGate(gate, passEntry(), HEAD).status, "pass");
  assert.equal(evaluateGate(gate, { ...passEntry(), result: "fail" }, HEAD).status, "fail");
  const stale = evaluateGate(gate, passEntry(OTHER), HEAD);
  assert.equal(stale.status, "stale");
  assert.equal(stale.evidenceHead, OTHER);
});

test("evidence from another head never counts, even a pass", () => {
  const evidence = allGreenEvidence();
  evidence.test = passEntry(OTHER);
  const report = buildReleaseTrainReport(facts(), evidence);
  assert.equal(report.gates.find((gate) => gate.id === "test").status, "stale");
  assert.equal(report.nextAction.id, "run-gate");
  assert.match(report.nextAction.summary, /"test"/);
  assert.equal(report.ready, false);
});

test("next-action priority: detached > dirty > behind-base > failed gate > missing gate", () => {
  const evidence = allGreenEvidence();
  assert.equal(buildReleaseTrainReport(facts({ branch: "" }), evidence).nextAction.id, "attach-branch");
  assert.equal(buildReleaseTrainReport(facts({ dirtyFiles: 3 }), evidence).nextAction.id, "commit-or-stash");
  assert.equal(buildReleaseTrainReport(facts({ baseBehind: 2 }), evidence).nextAction.id, "sync-base");
  const failed = { ...evidence, build: { ...passEntry(), result: "fail" } };
  assert.equal(buildReleaseTrainReport(facts(), failed).nextAction.id, "fix-gate");
  assert.equal(buildReleaseTrainReport(facts(), {}).nextAction.id, "run-gate");
});

test("push comes after local gates pass, then CI evidence, then cut-release", () => {
  const evidence = allGreenEvidence();
  delete evidence["sandbox-smoke"];
  const unpushed = buildReleaseTrainReport(facts({ upstreamRef: "", upstreamAhead: null, upstreamBehind: null }), evidence);
  assert.equal(unpushed.nextAction.id, "push-branch");
  assert.match(unpushed.nextAction.command, /git push -u origin runyard\/v0\.6\.0-fable/);
  const ahead = buildReleaseTrainReport(facts({ upstreamAhead: 2 }), evidence);
  assert.equal(ahead.nextAction.id, "push-branch");
  const pushed = buildReleaseTrainReport(facts(), evidence);
  assert.equal(pushed.nextAction.id, "record-ci-evidence");
  assert.match(pushed.nextAction.command, /record sandbox-smoke --pass/);
  const done = buildReleaseTrainReport(facts(), allGreenEvidence());
  assert.equal(done.nextAction.id, "cut-release");
  assert.equal(done.ready, true);
  assert.deepEqual(done.blockers, []);
});

test("failed gate at HEAD is a blocker; ready stays false until cut-release with no blockers", () => {
  const evidence = { ...allGreenEvidence(), test: { ...passEntry(), result: "fail" } };
  const report = buildReleaseTrainReport(facts(), evidence);
  assert.equal(report.ready, false);
  assert.equal(report.blockers.length, 1);
  assert.match(report.blockers[0], /gate "test" failed at HEAD/);
});

test("report carries branch/version/tag/tree/relationship facts verbatim", () => {
  const report = buildReleaseTrainReport(facts({ tagsAtHead: ["v0.6.0"], dirtyFiles: 1 }), {});
  assert.equal(report.schema, "runyard.release-train.status/1");
  assert.equal(report.branch, "runyard/v0.6.0-fable");
  assert.equal(report.trainVersion, "0.6.0");
  assert.equal(report.packageVersion, "0.3.1");
  assert.deepEqual(report.tagsAtHead, ["v0.6.0"]);
  assert.deepEqual(report.workingTree, { dirty: true, dirtyFiles: 1 });
  assert.deepEqual(report.base, { ref: "origin/main", ahead: 2, behind: 0 });
  assert.deepEqual(report.upstream, { ref: "origin/runyard/v0.6.0-fable", ahead: 0, behind: 0 });
  assert.equal(report.evidenceFile, "/tmp/evidence.json");
});

test("missing base/upstream render as null, not fake zeros", () => {
  const report = buildReleaseTrainReport(
    facts({ baseRef: "", baseAhead: null, baseBehind: null, upstreamRef: "", upstreamAhead: null, upstreamBehind: null }),
    {}
  );
  assert.equal(report.base, null);
  assert.equal(report.upstream, null);
});

test("text rendering names the branch, every gate, blockers, and the next command", () => {
  const evidence = { ...allGreenEvidence(), build: { ...passEntry(), result: "fail" } };
  delete evidence["diff-check"];
  const text = renderReleaseTrainText(buildReleaseTrainReport(facts(), evidence));
  assert.match(text, /runyard\/v0\.6\.0-fable @ aaaaaaa \(train v0\.6\.0, package 0\.3\.1\)/);
  assert.match(text, /working tree: clean/);
  assert.match(text, /base origin\/main: ahead 2, behind 0/);
  assert.match(text, /upstream origin\/runyard\/v0\.6\.0-fable: in sync/);
  for (const gate of RELEASE_GATES) assert.ok(text.includes(gate.id), `mentions ${gate.id}`);
  assert.match(text, /blockers: gate "build" failed at HEAD/);
  assert.match(text, /next: fix-gate/);
  assert.match(text, /\$ node scripts\/release-train\.mjs gate build/);
});
