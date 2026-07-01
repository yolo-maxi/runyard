import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient.js";
import { api } from "./api.js";
import { electricEnabled } from "./electricConfig.js";
import { createElectricCollection } from "./electricCollection.js";
import {
  normalizeRunRow,
  normalizeRunnerRow,
  normalizeCapabilityRow,
  normalizeApprovalRow
} from "./electricNormalize.js";

// TanStack DB collections back the live, cross-view entities of the Hub.
//
// This branch replaces the legacy REST polling query layer with ElectricSQL
// shape streaming: each collection syncs from a Postgres shape (proxied +
// authed at /api/electric/v1/shape) and updates reactively with no setInterval.
// If Electric is disabled (electricEnabled() === false) or the stream hard-fails,
// collections transparently fall back to the original REST polling behavior, so
// the UI is identical either way. useLiveQuery consumers need no changes.

export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const isTerminalRun = (run) => TERMINAL_RUN_STATUSES.has(run?.status);

// Runs poll fast while anything is in flight, slow when the fleet is idle —
// mirrors the legacy 4s active-run poll without a manual loop. (Legacy path.)
function runsRefetchInterval(query) {
  const rows = query?.state?.data;
  if (Array.isArray(rows) && rows.some((r) => !isTerminalRun(r))) return 4_000;
  return 30_000;
}

const REPLICA_FULL = { replica: "full" };

function queryBacked({ queryKey, path, dataKey, getKey, refetchInterval }) {
  return createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey,
      queryFn: async () => (await api(path))[dataKey] ?? [],
      getKey,
      refetchInterval
    })
  );
}

function electricBacked({ id, getKey, parseRow, fallbackPath, dataKey }) {
  return createElectricCollection({
    id,
    table: id,
    params: REPLICA_FULL,
    getKey,
    parseRow,
    fallbackFetch: async () => (await api(fallbackPath))[dataKey] ?? []
  });
}

const useElectric = electricEnabled();

export const runsCollection = useElectric
  ? electricBacked({
      id: "runs",
      getKey: (run) => run.id,
      parseRow: normalizeRunRow,
      fallbackPath: "/api/runs?limit=200",
      dataKey: "runs"
    })
  : queryBacked({
      queryKey: ["runs"],
      path: "/api/runs?limit=200",
      dataKey: "runs",
      getKey: (run) => run.id,
      refetchInterval: runsRefetchInterval
    });

export const approvalsCollection = useElectric
  ? electricBacked({
      id: "approvals",
      getKey: (a) => a.id,
      parseRow: normalizeApprovalRow,
      fallbackPath: "/api/approvals",
      dataKey: "approvals"
    })
  : queryBacked({
      queryKey: ["approvals"],
      path: "/api/approvals",
      dataKey: "approvals",
      getKey: (a) => a.id,
      refetchInterval: 30_000
    });

export const runnersCollection = useElectric
  ? electricBacked({
      id: "runners",
      getKey: (r) => r.id,
      parseRow: normalizeRunnerRow,
      fallbackPath: "/api/runners",
      dataKey: "runners"
    })
  : queryBacked({
      queryKey: ["runners"],
      path: "/api/runners",
      dataKey: "runners",
      getKey: (r) => r.id,
      refetchInterval: 30_000
    });

export const capabilitiesCollection = useElectric
  ? electricBacked({
      id: "capabilities",
      getKey: (c) => c.slug ?? c.id,
      parseRow: normalizeCapabilityRow,
      fallbackPath: "/api/capabilities",
      dataKey: "capabilities"
    })
  : queryBacked({
      queryKey: ["capabilities"],
      path: "/api/capabilities",
      dataKey: "capabilities",
      getKey: (c) => c.slug ?? c.id,
      refetchInterval: 60_000
    });

// Invalidate a collection's backing query so it refetches (call after a
// mutation that the server has accepted). e.g. refreshCollection("runs").
// With Electric, collections resync automatically once the projector mirrors the
// write, so this is a harmless no-op; kept for the legacy fallback path.
export function refreshCollection(name) {
  return queryClient.invalidateQueries({ queryKey: [name] });
}
