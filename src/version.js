// Canonical running-version source for the /version endpoint and update-check.
//
// `version` is package.json's version (mirrored in env.version). gitTag/gitCommit
// are best-effort: read from explicit env overrides first (set by the installer /
// systemd when deployed from a release tarball that has no .git), then from git
// in the repo root. Every git call is wrapped — a missing .git or absent git
// binary yields "" and never throws. The result is cached for the process
// lifetime; the running code only changes across a restart, so re-shelling per
// request would be pure waste.
import { execFileSync } from "node:child_process";
import { env } from "./env.js";

let cached = null;

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: env.root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function resolveGitTag() {
  if (process.env.RUNYARD_GIT_TAG) return String(process.env.RUNYARD_GIT_TAG).trim();
  // Exact tag at HEAD if any (a deployed release sits on a tag); empty otherwise.
  return git(["describe", "--tags", "--exact-match"]) || git(["tag", "--points-at", "HEAD"]).split("\n")[0] || "";
}

function resolveGitCommit() {
  if (process.env.RUNYARD_GIT_COMMIT) return String(process.env.RUNYARD_GIT_COMMIT).trim();
  return git(["rev-parse", "--short", "HEAD"]);
}

// { version, gitTag, gitCommit } — the exact shape GET /version returns. Nothing
// sensitive: a public version string, an optional tag name, and a short commit.
export function getVersionInfo() {
  if (cached) return cached;
  cached = {
    version: env.version,
    gitTag: resolveGitTag(),
    gitCommit: resolveGitCommit()
  };
  return cached;
}

// Test seam — lets a test pin the version triple without touching git.
export function __setVersionInfoForTest(value) {
  cached = value;
}
