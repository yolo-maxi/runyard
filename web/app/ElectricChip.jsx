import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { electricEnabled } from "../lib/electricConfig.js";

// Topbar chip that shows the Electric sync status for the demo: whether the
// Electric sync service is live and how many rows/events the SQLite->Postgres
// projector has mirrored. Makes it obvious the read path is Electric-backed.
export function ElectricChip() {
  const enabled = electricEnabled();
  const { data, isError } = useQuery({
    queryKey: ["electric-status"],
    queryFn: () => api("/api/electric/status"),
    refetchInterval: 5000,
    enabled
  });

  if (!enabled) return null;

  const live = !isError && data?.electric === "active";
  const events = data?.projector?.events;
  const title = live
    ? `Electric sync live · ${events ?? 0} trace events mirrored`
    : "Electric sync unavailable — using REST fallback";

  return (
    <span
      className="env-chip"
      data-env={live ? "production" : "local"}
      aria-label="Electric sync status"
      title={title}
    >
      <span className="env-chip-dot" aria-hidden="true" />
      <span className="env-chip-host">⚡ Electric</span>
      <span className="env-chip-tag">{live ? "live" : "offline"}</span>
    </span>
  );
}
