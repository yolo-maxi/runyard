import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearAwaitingRepairMeta,
  markFreshRerunMeta,
  markRepairDispatchedMeta,
  markResumeMeta,
  markTerminalMeta,
  nextSupervisorAttempt,
  normalizeSupervisorMeta,
  readSupervisorMeta
} from "../src/runSupervisorMeta.js";

describe("run supervisor meta helpers", () => {
  it("normalizes supervisor meta with stable defaults", () => {
    assert.deepEqual(readSupervisorMeta({ supervisor_meta: "{\"lastProgressMarker\":4,\"awaitingRepair\":true}" }), {
      repairedFingerprints: {},
      fingerprintResumes: {},
      lastProgressMarker: 4,
      lastFingerprint: "",
      lastCheckpoint: "",
      adjudicated: false,
      lastDecision: "",
      awaitingRepair: true,
      repairChildRunId: ""
    });

    assert.deepEqual(normalizeSupervisorMeta({ repairedFingerprints: "bad" }).repairedFingerprints, {});
    assert.equal(readSupervisorMeta({ supervisor_meta: "bad json" }).lastProgressMarker, 0);
  });

  it("marks resume, rerun, terminal, and repair meta transitions", () => {
    const resume = markResumeMeta({ fingerprintResumes: { fp: 1 } }, {
      fingerprint: "fp",
      checkpoint: "sid",
      progressMarker: 7
    });
    assert.equal(resume.fingerprintResumes.fp, 2);
    assert.equal(resume.lastDecision, "resume");
    assert.equal(resume.lastCheckpoint, "sid");
    assert.equal(resume.lastProgressMarker, 7);

    const rerun = markFreshRerunMeta({ awaitingRepair: true, adjudicated: true });
    assert.equal(rerun.awaitingRepair, false);
    assert.equal(rerun.adjudicated, false);
    assert.equal(rerun.lastDecision, "repair_rerun");

    const terminal = markTerminalMeta({ lastFingerprint: "old" }, { action: "escalate" });
    assert.equal(terminal.adjudicated, true);
    assert.equal(terminal.lastDecision, "escalate");
    assert.equal(terminal.lastFingerprint, "old");

    const repair = markRepairDispatchedMeta({ repairedFingerprints: { fp: 1 } }, {
      fingerprint: "fp",
      repairChildRunId: "pending"
    });
    assert.equal(repair.repairedFingerprints.fp, 2);
    assert.equal(repair.awaitingRepair, true);
    assert.equal(repair.repairChildRunId, "");

    assert.equal(clearAwaitingRepairMeta({ awaitingRepair: true }).awaitingRepair, false);
  });

  it("increments supervisor attempts from stored values", () => {
    assert.equal(nextSupervisorAttempt({ attempt: 2 }), 3);
    assert.equal(nextSupervisorAttempt({ attempt: "bad" }), 1);
  });
});
