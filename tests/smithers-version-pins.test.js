import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The Smithers engine version is pinned in several independent places — the app
// dependency, the runner install script, the runner image build, the deploy
// docs, and the lockfile. They drifted once (Dockerfile.runner/DEPLOY.md ran
// ahead to 0.25.1 while everything else stayed at 0.22.0), which means the image
// shipped a different engine than the resolver/tests expect. This guard fails
// the build the moment any pin disagrees with package.json (the source of truth).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// Source of truth: the app's declared dependency, with any range prefix stripped.
const CANON = JSON.parse(read("package.json")).dependencies["smithers-orchestrator"].replace(/^[\^~]/, "");

function extract(rel, re, label) {
  const m = read(rel).match(re);
  assert.ok(m, `could not find the Smithers version pin in ${rel} (${label})`);
  return m[1];
}

describe("Smithers engine version pins agree", () => {
  it("package.json declares a concrete version", () => {
    assert.match(CANON, /^\d+\.\d+\.\d+$/, "package.json should pin an exact smithers-orchestrator version");
  });

  const pins = {
    "install.sh (runner install default)": () =>
      extract("install.sh", /smithers-orchestrator@\$\{RUNYARD_SMITHERS_VERSION:-([\d.]+)\}/, "install default"),
    "Dockerfile.runner (image build ARG)": () =>
      extract("Dockerfile.runner", /^ARG SMITHERS_VERSION=([\d.]+)/m, "build ARG"),
    "DEPLOY.md (deploy docs)": () =>
      extract("DEPLOY.md", /`SMITHERS_VERSION=([\d.]+)`/, "docs ARG"),
    "pnpm-lock.yaml (lockfile)": () =>
      extract("pnpm-lock.yaml", /^\s+smithers-orchestrator:\s*\n\s+specifier:\s*([\d.]+)\s*$/m, "lockfile specifier")
  };

  for (const [label, get] of Object.entries(pins)) {
    it(`${label} matches package.json (${CANON})`, () => {
      assert.equal(get(), CANON, `${label} must pin smithers-orchestrator ${CANON}`);
    });
  }
});
