import { useState, useEffect, useCallback } from "react";

// Small persistence hooks replacing the legacy localStorage/sessionStorage
// preference reads/writes in app.js (log wrap, hide-routine, section open
// state, support-chat tabs, rerun drafts, etc.).

function makeStorageHook(getStore) {
  return function useStored(key, initial) {
    const [value, setValue] = useState(() => {
      try {
        const raw = getStore()?.getItem(key);
        return raw == null ? initial : JSON.parse(raw);
      } catch {
        return initial;
      }
    });
    useEffect(() => {
      try {
        const store = getStore();
        if (!store) return;
        if (value === undefined) store.removeItem(key);
        else store.setItem(key, JSON.stringify(value));
      } catch {
        /* quota / disabled storage — ignore, matches legacy best-effort writes */
      }
    }, [key, value]);
    return [value, setValue];
  };
}

const safeLocal = () => (typeof localStorage !== "undefined" ? localStorage : null);
const safeSession = () => (typeof sessionStorage !== "undefined" ? sessionStorage : null);

export const useLocalStorage = makeStorageHook(safeLocal);
export const useSessionStorage = makeStorageHook(safeSession);

// Read/write raw (non-hook) helpers for one-off access outside components.
export function readStored(store, key, fallback) {
  try {
    const raw = store?.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// A 1s ticking clock for live durations (replaces the run-detail setInterval).
export function useNow(intervalMs = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled, tick]);
  return now;
}
