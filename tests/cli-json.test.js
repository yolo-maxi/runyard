import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  parseJsonOption,
  readJsonFileOrEmpty,
  writePrettyJsonFile
} from "../src/cliJson.js";

describe("CLI JSON helpers", () => {
  it("parses labeled JSON options and reports useful errors", () => {
    assert.deepEqual(parseJsonOption('{"topic":"ship"}', "--input"), { topic: "ship" });
    assert.throws(
      () => parseJsonOption("{bad", "--chain"),
      /Invalid --chain:/
    );
  });

  it("reads missing or invalid config files as empty objects", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runyard-cli-json-"));
    const missing = path.join(dir, "missing.json");
    const invalid = path.join(dir, "invalid.json");
    writeFileSync(invalid, "{bad");

    assert.deepEqual(readJsonFileOrEmpty(missing), {});
    assert.deepEqual(readJsonFileOrEmpty(invalid), {});
  });

  it("writes pretty JSON with a trailing newline", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runyard-cli-json-"));
    const file = path.join(dir, "config.json");

    writePrettyJsonFile(file, { mcpServers: { runyard: { command: "node" } } });

    assert.equal(readFileSync(file, "utf8"), '{\n  "mcpServers": {\n    "runyard": {\n      "command": "node"\n    }\n  }\n}\n');
  });
});
