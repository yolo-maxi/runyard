// Retired run-smithers supervision envelope.
//
// RunYard used to wrap Smithers capabilities in a `run-smithers` watcher that
// tried to self-heal by retrying, repairing workflow code, and escalating. In
// dogfood it became a frequent source of failures and queue noise, so normal
// runs are now dispatched directly. The compatibility helpers remain only so
// old stored runs can still be presented/redacted safely.

import { randomToken } from "./security.js";

export const SUPERVISOR_CAPABILITY_SLUG = "run-smithers";

// Internal marker a child run carries so the Hub knows it was spawned *by* a
// supervising run-smithers run and must not be wrapped again. The token is
// minted by the Hub when it creates the supervising run and is redacted from
// every API response, so a public caller cannot forge a valid bypass to skip
// required supervision for a normal user-triggered run.
export const SUPERVISION_CHILD_KEY = "__supervisedChild";
export const SUPERVISION_TOKEN_KEY = "__supervisionToken";

// Input keys that are internal supervision plumbing and must never be surfaced
// to API callers or forwarded into a wrapped workflow's own input.
export const SUPERVISION_INTERNAL_KEYS = [SUPERVISION_CHILD_KEY, SUPERVISION_TOKEN_KEY];

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

// Supervision is retired: no capability defaults to wrapping, even if a stale
// seed/config row still says `supervision.default=true`.
export function capabilityDefaultsToSupervision(capability) {
  if (!capability || typeof capability !== "object") return false;
  return false;
}

// Pull the internal bypass marker off a run input, if present and well-formed.
export function readSupervisionBypass(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const marker = input[SUPERVISION_CHILD_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const token = typeof marker.token === "string" ? marker.token.trim() : "";
  if (!token) return null;
  return {
    token,
    parentRunId: typeof marker.parentRunId === "string" ? marker.parentRunId : "",
    purpose: typeof marker.purpose === "string" ? marker.purpose.trim() : ""
  };
}

// Remove internal supervision plumbing from an input object before it is stored
// on a child run or serialized to an API caller. Returns a shallow copy.
export function stripSupervisionInternals(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (!SUPERVISION_INTERNAL_KEYS.some((key) => key in input)) return input;
  const copy = { ...input };
  for (const key of SUPERVISION_INTERNAL_KEYS) delete copy[key];
  return copy;
}

export function mintSupervisionToken() {
  return `sup_${randomToken()}`;
}

// Build the input for the supervising run-smithers run. The original
// user-supplied input (minus any internal markers) becomes `wrappedInput`, so
// the child run the watcher spawns receives exactly what the user asked for.
export function buildSupervisorInput({ capability, input, goal = "", token }) {
  const wrappedInput = stripSupervisionInternals(input) || {};
  return {
    wrappedCapability: capability.slug,
    wrappedInput,
    goal: goal || `Supervise ${capability.name || capability.slug}`,
    [SUPERVISION_TOKEN_KEY]: token
  };
}

// Decide what to do with an incoming run request. Pure function; the caller
// provides a `findSupervisorByToken(token, wrappedCapability)` lookup so old
// in-flight supervised child requests can still be recognized during rollout.
//
// Returns one of:
//   { action: "wrap" }                       — create a run-smithers envelope
//   { action: "direct" }                     — run the capability as-is
//   { action: "direct", parentRunId, bypass } — verified supervised child run
export function decideSupervision(capability, input, { findSupervisorByToken } = {}) {
  if (!capability) return { action: "direct" };
  // The wrapper is never wrapped — hard recursion base case.
  if (capability.slug === SUPERVISOR_CAPABILITY_SLUG) return { action: "direct" };

  const bypass = readSupervisionBypass(input);
  if (bypass) {
    // A bypass is only honored when it points at a real, still-active
    // supervising run-smithers run. Normal child retries must match the
    // wrapped capability exactly. A one-shot self-repair child is allowed to
    // dispatch implement-change-gated directly because it is still inside the
    // same supervisor loop and presents the same secret token.
    const isRepairBypass = bypass.purpose === "repair" && capability.slug === "implement-change-gated";
    const parent = typeof findSupervisorByToken === "function"
      ? findSupervisorByToken(bypass.token, isRepairBypass ? "" : capability.slug)
      : null;
    if (parent && !TERMINAL_STATUSES.has(parent.status)) {
      return { action: "direct", parentRunId: parent.id, bypass };
    }
  }

  if (capabilityDefaultsToSupervision(capability)) return { action: "wrap" };
  return { action: "direct" };
}
