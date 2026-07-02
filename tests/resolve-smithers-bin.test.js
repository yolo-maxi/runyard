import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSmithersBin, resolveExecWrapper, parseCommandList } from "../src/resolveSmithersBin.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "resolve-smithers-"));
}

describe("resolveSmithersBin", () => {
  it("honours an explicit SMITHERS_BIN override above everything else", () => {
    const dir = tmpDir();
    // A bun install also exists, but the explicit override must win.
    const bunBin = path.join(dir, "bin");
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(path.join(bunBin, "smithers"), "#!/bin/sh\n");
    const resolved = resolveSmithersBin({ SMITHERS_BIN: "/opt/custom/smithers", BUN_INSTALL: dir });
    assert.equal(resolved, "/opt/custom/smithers");
  });

  it("uses the bun global install path ($BUN_INSTALL/bin/smithers) when present", () => {
    const dir = tmpDir();
    const bunBin = path.join(dir, "bin");
    mkdirSync(bunBin, { recursive: true });
    const smithers = path.join(bunBin, "smithers");
    writeFileSync(smithers, "#!/bin/sh\n");
    const resolved = resolveSmithersBin({ BUN_INSTALL: dir });
    assert.equal(resolved, smithers);
  });

  it("falls back to bare `smithers` on PATH when no bun install is found", () => {
    const dir = tmpDir(); // empty: no bin/smithers under it
    const resolved = resolveSmithersBin({ BUN_INSTALL: dir });
    assert.equal(resolved, "smithers");
  });

  it("treats an empty SMITHERS_BIN as unset", () => {
    const dir = tmpDir();
    const resolved = resolveSmithersBin({ SMITHERS_BIN: "  ", BUN_INSTALL: dir });
    assert.equal(resolved, "smithers");
  });
});

test("resolveExecWrapper: unset -> empty (bare host default)", () => {
  assert.deepEqual(resolveExecWrapper({}), []);
  assert.deepEqual(resolveExecWrapper({ RUNNER_EXEC_WRAPPER: "   " }), []);
});

test("resolveExecWrapper: whitespace string tokenizes", () => {
  assert.deepEqual(resolveExecWrapper({ RUNNER_EXEC_WRAPPER: "docker run --rm img" }), ["docker", "run", "--rm", "img"]);
});

test("resolveExecWrapper: JSON array preserves args with spaces", () => {
  assert.deepEqual(
    resolveExecWrapper({ RUNNER_EXEC_WRAPPER: '["docker","run","--rm","-v","/a b:/w","img"]' }),
    ["docker", "run", "--rm", "-v", "/a b:/w", "img"]
  );
});

test("resolveExecWrapper: RUNYARD_ alias works", () => {
  assert.deepEqual(resolveExecWrapper({ RUNYARD_RUNNER_EXEC_WRAPPER: "firejail" }), ["firejail"]);
});

test("parseCommandList: shared tokenizer handles blank, whitespace, and JSON forms", () => {
  assert.deepEqual(parseCommandList(""), []);
  assert.deepEqual(parseCommandList("   "), []);
  assert.deepEqual(parseCommandList(undefined), []);
  assert.deepEqual(parseCommandList("/opt/a /opt/b"), ["/opt/a", "/opt/b"]);
  assert.deepEqual(parseCommandList('["/a b","/c"]'), ["/a b", "/c"]);
});
