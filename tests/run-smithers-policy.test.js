import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  RUN_SMITHERS_LINEAGE_SCHEMA_VERSION
} from "../src/runSmithersPolicy.js";
import * as watcher from "../src/runSmithersWatcher.js";

describe("run-smithers shared policy", () => {
  it("defines bounded retry, fingerprint, and repair defaults", () => {
    assert.equal(RUN_SMITHERS_FINGERPRINT_LIMIT, 3);
    assert.ok(RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS >= RUN_SMITHERS_FINGERPRINT_LIMIT);
    assert.equal(RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS, 1);
    assert.match(RUN_SMITHERS_LINEAGE_SCHEMA_VERSION, /run-smithers\.watcher\.v1$/);
  });

  it("keeps the watcher module's compatibility re-exports stable", () => {
    assert.equal(watcher.RUN_SMITHERS_FINGERPRINT_LIMIT, RUN_SMITHERS_FINGERPRINT_LIMIT);
    assert.equal(watcher.RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS, RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS);
    assert.equal(watcher.RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS, RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS);
    assert.equal(watcher.RUN_SMITHERS_LINEAGE_SCHEMA_VERSION, RUN_SMITHERS_LINEAGE_SCHEMA_VERSION);
  });
});
