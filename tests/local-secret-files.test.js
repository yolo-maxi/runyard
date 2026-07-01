import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  readOrCreateTokenFile,
  readTokenFile,
  writePrivateTokenFile
} from "../src/localSecretFiles.js";

function tempPath(name) {
  return path.join(mkdtempSync(path.join(tmpdir(), "runyard-secret-file-")), name);
}

describe("local secret file helpers", () => {
  it("reads trimmed token files and returns empty for missing files", () => {
    const file = tempPath("token.txt");
    assert.equal(readTokenFile(file), "");
    writePrivateTokenFile(file, "abc123");
    assert.equal(readFileSync(file, "utf8"), "abc123\n");
    assert.equal(readTokenFile(file), "abc123");
  });

  it("creates private token files once and reuses existing values", () => {
    const file = tempPath("nested/token.txt");
    const created = [];
    const first = readOrCreateTokenFile(file, {
      createToken: () => "first-token",
      onCreate: (createdFile, token) => created.push({ file: createdFile, token })
    });
    const second = readOrCreateTokenFile(file, {
      createToken: () => "second-token",
      onCreate: () => {
        throw new Error("should not recreate existing token");
      }
    });

    assert.equal(first, "first-token");
    assert.equal(second, "first-token");
    assert.deepEqual(created, [{ file, token: "first-token" }]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
