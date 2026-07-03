#!/usr/bin/env node
// Release-train status for operators and the host watchdog. Thin impure shell:
// collects git facts + the evidence file, then delegates every decision to the
// pure module src/releaseTrain.js.
//
//   node scripts/release-train.mjs status [--json] [--base <ref>] [--dir <path>]
//   node scripts/release-train.mjs gate <id> [--dir <path>]        run a local gate, record pass/fail
//   node scripts/release-train.mjs record <id> --pass|--fail [--note <text>] [--dir <path>]
//
// Evidence lives at <dir>/data/release-evidence.json (gitignored), keyed by the
// full HEAD SHA the gate ran against; RUNYARD_RELEASE_EVIDENCE_FILE overrides.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_EVIDENCE_SCHEMA,
  buildReleaseTrainReport,
  findReleaseGate,
  renderReleaseTrainText
} from "../src/releaseTrain.js";

const DEFAULT_BASE = "origin/main";

function usageFail(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write("usage: release-train.mjs status [--json] [--base <ref>] [--dir <path>]\n");
  process.stderr.write("       release-train.mjs gate <id> [--dir <path>]\n");
  process.stderr.write("       release-train.mjs record <id> --pass|--fail [--note <text>] [--dir <path>]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { command: "status", positional: [], json: false, base: DEFAULT_BASE, dir: "", note: "", result: "" };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) args.command = rest.shift();
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--json") args.json = true;
    else if (arg === "--pass") args.result = "pass";
    else if (arg === "--fail") args.result = "fail";
    else if (arg === "--base") args.base = rest.shift() || usageFail("--base needs a ref");
    else if (arg === "--dir") args.dir = rest.shift() || usageFail("--dir needs a path");
    else if (arg === "--note") args.note = rest.shift() ?? usageFail("--note needs text");
    else if (arg.startsWith("--")) usageFail(`unknown flag: ${arg}`);
    else args.positional.push(arg);
  }
  return args;
}

// Same never-throw discipline as src/version.js: a missing ref/binary yields
// "" so status always renders, just with unknowns.
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function aheadBehind(ref, cwd) {
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...${ref}`], cwd);
  const match = /^(\d+)\s+(\d+)$/.exec(counts);
  if (!match) return { ahead: null, behind: null };
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function collectGitFacts(dir, baseRef, evidenceFile) {
  const rawBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const branch = rawBranch === "HEAD" ? "" : rawBranch;
  const upstreamRef = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], dir);
  const base = aheadBehind(baseRef, dir);
  const upstream = upstreamRef ? aheadBehind(upstreamRef, dir) : { ahead: null, behind: null };
  let packageVersion = "";
  try {
    packageVersion = String(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version || "");
  } catch {
    // no package.json (or unparseable) — report "" rather than dying
  }
  const porcelain = git(["status", "--porcelain"], dir);
  return {
    generatedAt: new Date().toISOString(),
    branch,
    headSha: git(["rev-parse", "HEAD"], dir),
    headShort: git(["rev-parse", "--short", "HEAD"], dir),
    headSubject: git(["log", "-1", "--format=%s"], dir),
    packageVersion,
    tagsAtHead: git(["tag", "--points-at", "HEAD"], dir).split("\n").filter(Boolean),
    dirtyFiles: porcelain ? porcelain.split("\n").filter(Boolean).length : 0,
    baseRef: base.ahead === null ? "" : baseRef,
    baseAhead: base.ahead,
    baseBehind: base.behind,
    upstreamRef,
    upstreamAhead: upstream.ahead,
    upstreamBehind: upstream.behind,
    evidenceFile
  };
}

function readEvidence(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed.entries === "object" && parsed.entries !== null ? parsed.entries : {};
  } catch {
    return {};
  }
}

function recordEvidence(file, gateId, entry) {
  const entries = readEvidence(file);
  entries[gateId] = entry;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: RELEASE_EVIDENCE_SCHEMA, entries }, null, 2)}\n`);
}

function requireGate(id) {
  const gate = findReleaseGate(id);
  if (!gate) usageFail(`unknown gate: ${id} (known: test, build, diff-check, sandbox-smoke)`);
  return gate;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir
  ? path.resolve(args.dir)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceFile = process.env.RUNYARD_RELEASE_EVIDENCE_FILE || path.join(dir, "data", "release-evidence.json");

if (args.command === "status") {
  const report = buildReleaseTrainReport(collectGitFacts(dir, args.base, evidenceFile), readEvidence(evidenceFile));
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReleaseTrainText(report)}\n`);
} else if (args.command === "gate") {
  const gate = requireGate(args.positional[0] || usageFail("gate needs an id"));
  if (gate.kind !== "local") usageFail(`gate "${gate.id}" only runs in CI — record its result with: record ${gate.id} --pass --note <ci-run-url>`);
  const head = git(["rev-parse", "HEAD"], dir);
  if (!head) usageFail(`not a git repository: ${dir}`);
  process.stderr.write(`release-train gate ${gate.id}: ${gate.command.join(" ")}\n`);
  const run = spawnSync(gate.command[0], gate.command.slice(1), { cwd: dir, stdio: "inherit" });
  const result = run.status === 0 ? "pass" : "fail";
  recordEvidence(evidenceFile, gate.id, {
    head,
    result,
    recordedAt: new Date().toISOString(),
    note: `exit ${run.status ?? "signal"}`
  });
  process.stderr.write(`release-train gate ${gate.id}: ${result} (recorded for ${head.slice(0, 7)})\n`);
  process.exit(run.status ?? 1);
} else if (args.command === "record") {
  const gate = requireGate(args.positional[0] || usageFail("record needs a gate id"));
  if (args.result !== "pass" && args.result !== "fail") usageFail("record needs --pass or --fail");
  const head = git(["rev-parse", "HEAD"], dir);
  if (!head) usageFail(`not a git repository: ${dir}`);
  recordEvidence(evidenceFile, gate.id, {
    head,
    result: args.result,
    recordedAt: new Date().toISOString(),
    note: args.note || null
  });
  process.stderr.write(`release-train record ${gate.id}: ${args.result} (recorded for ${head.slice(0, 7)})\n`);
} else {
  usageFail(`unknown command: ${args.command}`);
}
