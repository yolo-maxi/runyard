// Turns an Electric shape stream into a TanStack DB collection, using the same
// low-level createCollection({ sync }) contract the app already uses for the
// per-run event collection. Consumers keep calling useLiveQuery(collection) and
// get live, reactive data straight off Electric — no polling, no setInterval.
//
// Fallback: if the Electric stream hard-fails (proxy/sync service down), the
// collection transparently degrades to polling the legacy REST endpoint, so the
// UI keeps working exactly as before Electric existed.
import { createCollection } from "@tanstack/react-db";
import { createShapeStream } from "./electricShape.js";

const HARD_FAIL_THRESHOLD = 4;
const FALLBACK_POLL_MS = 5000;

export function createElectricCollection({
  id,
  table,
  params = {},
  getKey,
  parseRow,
  gcTime,
  fallbackFetch
}) {
  return createCollection({
    id,
    ...(gcTime != null ? { gcTime } : {}),
    getKey,
    sync: {
      sync: (handle) => {
        const { begin, write, commit, markReady } = handle;
        const knownKeys = new Set();
        const valueByKey = new Map();
        let ready = false;
        let stream = null;
        let pollTimer = null;
        let hardFailures = 0;
        let stopped = false;

        function ensureReady() {
          if (!ready) {
            ready = true;
            markReady();
          }
        }

        function applyOps(ops) {
          begin();
          for (const op of ops) {
            if (op.operation === "delete") {
              const existing = valueByKey.get(op.key);
              const value = existing || (op.value ? parseRow(op.value) : null);
              if (value) {
                write({ type: "delete", value });
                const k = getKey(value);
                knownKeys.delete(k);
                valueByKey.delete(k);
              }
              continue;
            }
            const value = parseRow(op.value);
            const key = getKey(value);
            write({ type: knownKeys.has(key) ? "update" : "insert", value });
            knownKeys.add(key);
            valueByKey.set(key, value);
          }
          commit();
        }

        function clearAll() {
          if (!knownKeys.size) return;
          begin();
          for (const value of valueByKey.values()) {
            write({ type: "delete", value });
          }
          commit();
          knownKeys.clear();
          valueByKey.clear();
        }

        function upsertRows(rows) {
          begin();
          for (const value of rows) {
            const key = getKey(value);
            write({ type: knownKeys.has(key) ? "update" : "insert", value });
            knownKeys.add(key);
            valueByKey.set(key, value);
          }
          commit();
          ensureReady();
        }

        function startFallback() {
          if (stopped || pollTimer || !fallbackFetch) return;
          if (stream) {
            stream.stop();
            stream = null;
          }
          const tick = async () => {
            try {
              const rows = await fallbackFetch();
              if (!stopped && Array.isArray(rows)) upsertRows(rows);
            } catch {
              /* keep trying */
            }
          };
          tick();
          pollTimer = setInterval(tick, FALLBACK_POLL_MS);
        }

        function startStream() {
          stream = createShapeStream({
            table,
            params,
            onOps: applyOps,
            onUpToDate: () => {
              hardFailures = 0;
              ensureReady();
            },
            onMustRefetch: clearAll,
            onError: () => {
              hardFailures += 1;
              if (hardFailures >= HARD_FAIL_THRESHOLD && fallbackFetch) startFallback();
            }
          });
        }

        startStream();

        return () => {
          stopped = true;
          if (stream) stream.stop();
          if (pollTimer) clearInterval(pollTimer);
        };
      }
    }
  });
}
