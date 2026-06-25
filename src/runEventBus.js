// In-process pub/sub for run events, keyed by runId. This is the additive
// backbone of the live SSE stream (GET /api/runs/:id/events/stream): every
// persisted run event is published here, and the SSE route subscribes per run.
//
// It is intentionally a tiny per-run Map<Set> rather than a Node EventEmitter
// so we never hit the default-10-listeners warning when many operators tail the
// same run, and unsubscribe is O(1). It changes no existing behavior — when no
// one is subscribed, emit is a cheap no-op.

const subscribers = new Map(); // runId -> Set<(event) => void>

// Publish an event to everyone tailing this run. Never throws into the caller
// (addRunEvent must stay side-effect-clean for the persistence path).
export function emitRunEvent(event) {
  if (!event || !event.runId) return;
  const set = subscribers.get(event.runId);
  if (!set || set.size === 0) return;
  for (const fn of [...set]) {
    try {
      fn(event);
    } catch {
      // A misbehaving subscriber must not break event persistence or other tails.
    }
  }
}

// Subscribe to a run's events. Returns an unsubscribe function.
export function subscribeRunEvents(runId, listener) {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(listener);
  return () => {
    const current = subscribers.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) subscribers.delete(runId);
  };
}

// Test/introspection helper: how many tails are open for a run.
export function subscriberCount(runId) {
  return subscribers.get(runId)?.size || 0;
}
