import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient.js";
import { api } from "./api.js";

// TanStack DB collections back the live, cross-view entities of the Hub. Each
// collection's sync source is a TanStack Query (via queryCollectionOptions), so
// we get polling + reactive `useLiveQuery` for free — this is what replaces the
// hand-rolled setInterval loops in the legacy app.js (sidebar badges, the 4s
// active-run progress poll, etc.). On-demand / single-view reads stay as plain
// useQuery in their view components.

export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const isTerminalRun = (run) => TERMINAL_RUN_STATUSES.has(run?.status);

// Runs poll fast while anything is in flight, slow when the fleet is idle —
// mirrors the legacy 4s active-run poll without a manual loop.
function runsRefetchInterval(query) {
  const rows = query?.state?.data;
  if (Array.isArray(rows) && rows.some((r) => !isTerminalRun(r))) return 4_000;
  return 30_000;
}

export const runsCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["runs"],
    queryFn: async () => (await api("/api/runs?limit=200")).runs ?? [],
    getKey: (run) => run.id,
    refetchInterval: runsRefetchInterval
  })
);

export const approvalsCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["approvals"],
    queryFn: async () => (await api("/api/approvals")).approvals ?? [],
    getKey: (a) => a.id,
    refetchInterval: 30_000
  })
);

export const runnersCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["runners"],
    queryFn: async () => (await api("/api/runners")).runners ?? [],
    getKey: (r) => r.id,
    refetchInterval: 30_000
  })
);

export const capabilitiesCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["capabilities"],
    queryFn: async () => (await api("/api/capabilities")).capabilities ?? [],
    getKey: (c) => c.slug ?? c.id,
    refetchInterval: 60_000
  })
);

// Invalidate a collection's backing query so it refetches (call after a
// mutation that the server has accepted). e.g. refreshCollection("runs").
export function refreshCollection(name) {
  return queryClient.invalidateQueries({ queryKey: [name] });
}
