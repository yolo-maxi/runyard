import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRANCH_INPUT_KEYS,
  PROJECT_INPUT_KEYS,
  firstContextString,
  firstString,
  normalizeOrigin,
  truncate,
  uniqueNonempty
} from "../src/presentation.js";

describe("presentation helpers", () => {
  it("finds direct strings before nested context strings", () => {
    const input = {
      project: " direct-project ",
      context: { project: "nested-project", branch: "main" }
    };
    assert.equal(firstString(input, PROJECT_INPUT_KEYS), "direct-project");
    assert.equal(firstContextString(input, PROJECT_INPUT_KEYS), "direct-project");
    assert.equal(firstContextString(input, BRANCH_INPUT_KEYS), "main");
  });

  it("dedupes and drops blank display fragments", () => {
    assert.deepEqual(uniqueNonempty([" repo ", "", "repo", null, "branch"]), ["repo", "branch"]);
  });

  it("truncates on word boundaries with the existing ellipsis character", () => {
    assert.equal(truncate("hello broad world", 12), "hello\u2026");
    assert.equal(truncate("short", 12), "short");
  });

  it("normalizes origin strings and removes empty object fields", () => {
    assert.deepEqual(normalizeOrigin("cli"), { label: "cli" });
    assert.deepEqual(normalizeOrigin({ type: "mcp", name: "Agent", empty: "", nil: null }), {
      type: "mcp",
      name: "Agent",
      label: "Agent"
    });
    assert.equal(normalizeOrigin({ empty: "" }), null);
    assert.equal(normalizeOrigin(["bad"]), null);
  });
});
