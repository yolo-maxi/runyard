import { parseMaybeJson } from "./dbNormalization.js";

export function normalizeSupervisorMeta(meta = {}) {
  return {
    repairedFingerprints: meta.repairedFingerprints && typeof meta.repairedFingerprints === "object" ? meta.repairedFingerprints : {},
    fingerprintResumes: meta.fingerprintResumes && typeof meta.fingerprintResumes === "object" ? meta.fingerprintResumes : {},
    lastProgressMarker: Number(meta.lastProgressMarker) || 0,
    lastFingerprint: meta.lastFingerprint || "",
    lastCheckpoint: meta.lastCheckpoint || "",
    adjudicated: Boolean(meta.adjudicated),
    lastDecision: meta.lastDecision || "",
    awaitingRepair: Boolean(meta.awaitingRepair),
    repairChildRunId: meta.repairChildRunId || ""
  };
}

export function readSupervisorMeta(row) {
  const meta = parseMaybeJson(row?.supervisor_meta, {}) || {};
  return normalizeSupervisorMeta(meta);
}

export function markResumeMeta(meta, { fingerprint = "", checkpoint = "", progressMarker = 0 } = {}) {
  const next = normalizeSupervisorMeta(meta);
  if (fingerprint) next.fingerprintResumes[fingerprint] = (next.fingerprintResumes[fingerprint] || 0) + 1;
  next.lastFingerprint = fingerprint;
  next.lastCheckpoint = checkpoint || "";
  next.lastProgressMarker = progressMarker;
  next.adjudicated = false;
  next.lastDecision = "resume";
  return next;
}

export function markFreshRerunMeta(meta) {
  return {
    ...normalizeSupervisorMeta(meta),
    adjudicated: false,
    awaitingRepair: false,
    lastDecision: "repair_rerun"
  };
}

export function markTerminalMeta(meta, decision = {}) {
  const current = normalizeSupervisorMeta(meta);
  return {
    ...current,
    adjudicated: true,
    lastDecision: decision.action,
    lastFingerprint: decision.fingerprint || current.lastFingerprint
  };
}

export function markRepairDispatchedMeta(meta, { fingerprint = "", repairChildRunId = "" } = {}) {
  const next = normalizeSupervisorMeta(meta);
  if (fingerprint) next.repairedFingerprints[fingerprint] = (next.repairedFingerprints[fingerprint] || 0) + 1;
  next.lastDecision = "repair";
  next.lastFingerprint = fingerprint || next.lastFingerprint;
  next.awaitingRepair = true;
  next.repairChildRunId = repairChildRunId === "pending" ? "" : repairChildRunId;
  return next;
}

export function clearAwaitingRepairMeta(meta) {
  return {
    ...normalizeSupervisorMeta(meta),
    awaitingRepair: false
  };
}

export function nextSupervisorAttempt(row) {
  return (Number(row?.attempt) || 0) + 1;
}
