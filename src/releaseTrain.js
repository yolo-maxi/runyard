// Deterministic release-train status: pure facts-in/report-out so the host
// watchdog or an operator can poll machine-readable branch/gate state instead
// of scraping agent prose. All git/fs collection lives in
// scripts/release-train.mjs; everything here is a pure function of its inputs,
// so the whole decision surface is unit-testable without a repo.
//
// Evidence model: each gate's latest result is recorded keyed to the FULL head
// SHA it ran against. Evidence from any other commit is "stale" and never
// counts — a green gate can't be inherited across new commits by accident.

export const RELEASE_TRAIN_SCHEMA = "runyard.release-train.status/1";
export const RELEASE_EVIDENCE_SCHEMA = "runyard.release-train.evidence/1";

// The release gates release.yml/images.yml enforce, expressed locally. Local
// gates are commands the operator (or watchdog) can run on this machine; CI
// gates only run on a real Actions kernel, so their evidence is recorded by
// hand (`record sandbox-smoke --pass --note <run-url>`) once the run is green.
export const RELEASE_GATES = Object.freeze([
  Object.freeze({ id: "test", kind: "local", command: ["pnpm", "test"], summary: "unit + integration suite" }),
  Object.freeze({ id: "build", kind: "local", command: ["pnpm", "build"], summary: "vendor + web bundles compile" }),
  Object.freeze({ id: "diff-check", kind: "local", command: ["git", "diff", "--check"], summary: "no whitespace/conflict-marker damage" }),
  Object.freeze({
    id: "sandbox-smoke",
    kind: "ci",
    command: null,
    summary: "real bwrap + userns + AppArmor smoke (release.yml / images.yml)"
  })
]);

export function findReleaseGate(id) {
  return RELEASE_GATES.find((gate) => gate.id === id) || null;
}

// "runyard/v0.6.0-fable" -> "0.6.0"; anything off-pattern -> "".
export function parseTrainVersion(branch) {
  const match = /^runyard\/v(\d+\.\d+\.\d+)(?:-|$)/.exec(String(branch || ""));
  return match ? match[1] : "";
}

// One gate + its latest evidence entry -> display/decision row.
// status: pass | fail (at this head) | stale (evidence from another head) |
// missing (never recorded).
export function evaluateGate(gate, entry, headSha) {
  const row = {
    id: gate.id,
    kind: gate.kind,
    command: gate.command ? gate.command.join(" ") : null,
    summary: gate.summary,
    status: "missing",
    recordedAt: null,
    evidenceHead: null,
    note: null
  };
  if (!entry || typeof entry !== "object") return row;
  row.recordedAt = entry.recordedAt || null;
  row.evidenceHead = entry.head || null;
  row.note = entry.note || null;
  if (!headSha || entry.head !== headSha) {
    row.status = "stale";
    return row;
  }
  row.status = entry.result === "pass" ? "pass" : "fail";
  return row;
}

function gateCommandHint(gate) {
  return gate.kind === "local"
    ? `node scripts/release-train.mjs gate ${gate.id}`
    : `node scripts/release-train.mjs record ${gate.id} --pass --note <ci-run-url>`;
}

// Deterministic priority ladder. Exactly one next action; blockers are the
// subset that needs judgment (a gate that FAILED at this head, detached HEAD).
function deriveNextAction(facts, gates) {
  const failed = gates.filter((gate) => gate.status === "fail");
  if (!facts.branch) {
    return {
      id: "attach-branch",
      summary: "HEAD is detached — check out the train branch before doing anything else",
      command: "git switch <train-branch>"
    };
  }
  if (facts.dirtyFiles > 0) {
    return {
      id: "commit-or-stash",
      summary: `working tree has ${facts.dirtyFiles} dirty path(s) — commit or stash before gating`,
      command: "git status --short"
    };
  }
  if (typeof facts.baseBehind === "number" && facts.baseBehind > 0) {
    return {
      id: "sync-base",
      summary: `branch is ${facts.baseBehind} commit(s) behind ${facts.baseRef} — merge before gating`,
      command: `git merge ${facts.baseRef}`
    };
  }
  if (failed.length > 0) {
    const gate = findReleaseGate(failed[0].id);
    return {
      id: "fix-gate",
      summary: `gate "${failed[0].id}" failed at HEAD — fix, then re-run it`,
      command: gateCommandHint(gate)
    };
  }
  const pendingLocal = gates.find((gate) => gate.kind === "local" && gate.status !== "pass");
  if (pendingLocal) {
    return {
      id: "run-gate",
      summary: `gate "${pendingLocal.id}" has no passing evidence at HEAD — run it`,
      command: gateCommandHint(findReleaseGate(pendingLocal.id))
    };
  }
  const unpushed = !facts.upstreamRef || (typeof facts.upstreamAhead === "number" && facts.upstreamAhead > 0);
  if (unpushed) {
    return {
      id: "push-branch",
      summary: facts.upstreamRef
        ? `${facts.upstreamAhead} commit(s) not on ${facts.upstreamRef} — push`
        : "branch has no upstream — push it",
      command: `git push -u origin ${facts.branch}`
    };
  }
  const pendingCi = gates.find((gate) => gate.kind === "ci" && gate.status !== "pass");
  if (pendingCi) {
    return {
      id: "record-ci-evidence",
      summary: `CI gate "${pendingCi.id}" has no evidence at HEAD — wait for a green run, then record its URL`,
      command: gateCommandHint(findReleaseGate(pendingCi.id))
    };
  }
  return {
    id: "cut-release",
    summary: "all gates green at HEAD and branch pushed — cut the next train step (tag / merge / next branch)",
    command: null
  };
}

// facts: collected by the script (or a test) —
//   { generatedAt, branch, headSha, headShort, headSubject, packageVersion,
//     tagsAtHead, dirtyFiles, baseRef, baseAhead, baseBehind,
//     upstreamRef, upstreamAhead, upstreamBehind, evidenceFile }
// evidenceEntries: { [gateId]: { head, result, recordedAt, note } }
export function buildReleaseTrainReport(facts, evidenceEntries = {}) {
  const gates = RELEASE_GATES.map((gate) => evaluateGate(gate, evidenceEntries[gate.id], facts.headSha));
  const blockers = [];
  if (!facts.branch) blockers.push("HEAD is detached (no branch)");
  for (const gate of gates) {
    if (gate.status === "fail") blockers.push(`gate "${gate.id}" failed at HEAD (${facts.headShort || facts.headSha || "?"})`);
  }
  const nextAction = deriveNextAction(facts, gates);
  return {
    schema: RELEASE_TRAIN_SCHEMA,
    generatedAt: facts.generatedAt || null,
    branch: facts.branch || "",
    headSha: facts.headSha || "",
    headShort: facts.headShort || "",
    headSubject: facts.headSubject || "",
    packageVersion: facts.packageVersion || "",
    trainVersion: parseTrainVersion(facts.branch),
    tagsAtHead: Array.isArray(facts.tagsAtHead) ? facts.tagsAtHead : [],
    workingTree: { dirty: facts.dirtyFiles > 0, dirtyFiles: facts.dirtyFiles || 0 },
    base: facts.baseRef
      ? { ref: facts.baseRef, ahead: facts.baseAhead ?? null, behind: facts.baseBehind ?? null }
      : null,
    upstream: facts.upstreamRef
      ? { ref: facts.upstreamRef, ahead: facts.upstreamAhead ?? null, behind: facts.upstreamBehind ?? null }
      : null,
    gates,
    blockers,
    nextAction,
    ready: blockers.length === 0 && nextAction.id === "cut-release",
    evidenceFile: facts.evidenceFile || null
  };
}

const STATUS_MARK = { pass: "ok  ", fail: "FAIL", stale: "old ", missing: "--  " };

export function renderReleaseTrainText(report) {
  const lines = [];
  const branch = report.branch || "(detached)";
  const train = report.trainVersion ? `train v${report.trainVersion}, ` : "";
  lines.push(`release-train: ${branch} @ ${report.headShort || "?"} (${train}package ${report.packageVersion || "?"})`);
  if (report.headSubject) lines.push(`head: ${report.headSubject}`);
  if (report.tagsAtHead.length > 0) lines.push(`tags at head: ${report.tagsAtHead.join(", ")}`);
  lines.push(`working tree: ${report.workingTree.dirty ? `DIRTY (${report.workingTree.dirtyFiles} path(s))` : "clean"}`);
  for (const [label, rel] of [["base", report.base], ["upstream", report.upstream]]) {
    if (!rel) {
      lines.push(`${label}: none`);
    } else if (rel.ahead === null || rel.behind === null) {
      lines.push(`${label} ${rel.ref}: unknown`);
    } else if (rel.ahead === 0 && rel.behind === 0) {
      lines.push(`${label} ${rel.ref}: in sync`);
    } else {
      lines.push(`${label} ${rel.ref}: ahead ${rel.ahead}, behind ${rel.behind}`);
    }
  }
  lines.push("gates:");
  for (const gate of report.gates) {
    const when = gate.status === "pass" || gate.status === "fail" ? ` @ ${gate.recordedAt || "?"}` : "";
    const stale = gate.status === "stale" ? ` (evidence from ${String(gate.evidenceHead).slice(0, 7)})` : "";
    const note = gate.note ? ` — ${gate.note}` : "";
    lines.push(`  ${STATUS_MARK[gate.status]} ${gate.id.padEnd(13)} ${gate.status}${when}${stale}${note}`);
  }
  lines.push(`blockers: ${report.blockers.length > 0 ? report.blockers.join("; ") : "none"}`);
  lines.push(`next: ${report.nextAction.id} — ${report.nextAction.summary}`);
  if (report.nextAction.command) lines.push(`  $ ${report.nextAction.command}`);
  return lines.join("\n");
}
