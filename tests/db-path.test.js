import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { defaultDbPath } = await import("../src/env.js");

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "runyard-dbpath-"));
}
const writeSized = (p, bytes) => writeFileSync(p, Buffer.alloc(bytes, 1));

describe("defaultDbPath — never orphan a populated DB", () => {
  it("uses runyard.sqlite when only it exists", () => {
    const d = tmpDir();
    writeSized(path.join(d, "runyard.sqlite"), 4096);
    assert.equal(defaultDbPath(d), path.join(d, "runyard.sqlite"));
  });

  it("uses the legacy smithers-hub.sqlite when only it exists", () => {
    const d = tmpDir();
    writeSized(path.join(d, "smithers-hub.sqlite"), 4096);
    assert.equal(defaultDbPath(d), path.join(d, "smithers-hub.sqlite"));
  });

  it("defaults to runyard.sqlite when neither exists", () => {
    const d = tmpDir();
    assert.equal(defaultDbPath(d), path.join(d, "runyard.sqlite"));
  });

  it("CRITICAL: an empty runyard.sqlite must NOT shadow a populated legacy DB", () => {
    // The exact production bug: 4 KB fresh runyard.sqlite next to a 387 MB real
    // smithers-hub.sqlite. The bigger (real) one must win.
    const d = tmpDir();
    writeSized(path.join(d, "runyard.sqlite"), 4096);
    writeSized(path.join(d, "smithers-hub.sqlite"), 5_000_000);
    assert.equal(defaultDbPath(d), path.join(d, "smithers-hub.sqlite"));
  });

  it("a stale empty legacy DB must NOT shadow a populated runyard.sqlite either", () => {
    const d = tmpDir();
    writeSized(path.join(d, "runyard.sqlite"), 5_000_000);
    writeSized(path.join(d, "smithers-hub.sqlite"), 4096);
    assert.equal(defaultDbPath(d), path.join(d, "runyard.sqlite"));
  });
});
