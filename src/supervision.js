// Default supervision envelope.
//
// Real user-facing / mutating workflows (e.g. `improve`, `idea-to-product`)
// should not be dispatched bare: a silent runner death or mid-run failure must
// be captured and (where possible) recovered instead of looking like a green
// success. The `run-smithers` capability is that supervising envelope — it
// wraps a child capability request, records lineage, retries recoverable
// failures, and escalates to an operator approval after repeated identical
// failures.
//
// This module owns the *single* decision of whether a given run request should
// be wrapped, plus the internal bypass metadata that keeps the wrapper from
// recursively wrapping its own child runs. It is intentionally dependency-light
// so it can be unit-tested without a live server.

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

// A capability opts into the default supervision envelope with
// `supervision: { default: true }` in its seed metadata. The wrapper itself is
// never wrapped — that is the recursion base case.
export function capabilityDefaultsToSupervision(capability) {
  if (!capability || typeof capability !== "object") return false;
  if (capability.slug === SUPERVISOR_CAPABILITY_SLUG) return false;
  const supervision = capability.supervision;
  return Boolean(supervision && typeof supervision === "object" && supervision.default === true);
}

// Pull the internal bypass marker off a run input, if present and well-formed.
export function readSupervisionBypass(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const marker = input[SUPERVISION_CHILD_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const token = typeof marker.token === "string" ? marker.token.trim() : "";
  if (!token) return null;
  return { token, parentRunId: typeof marker.parentRunId === "string" ? marker.parentRunId : "" };
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
// provides a `findSupervisorByToken(token, wrappedCapability)` lookup so this
// module stays free of DB wiring.
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
    // supervising run-smithers run that wraps *this exact* capability. A forged
    // or stale marker falls through and gets wrapped like any other request.
    const parent = typeof findSupervisorByToken === "function"
      ? findSupervisorByToken(bypass.token, capability.slug)
      : null;
    if (parent && !TERMINAL_STATUSES.has(parent.status)) {
      return { action: "direct", parentRunId: parent.id, bypass };
    }
  }

  if (capabilityDefaultsToSupervision(capability)) return { action: "wrap" };
  return { action: "direct" };
}
