import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

// Connected-hub chip in the topbar. Sourced from the unauthenticated
// /api/setup endpoint so operators can tell which hub they're pointed at;
// also updates document.title (`<host> · <env> — <instance>`). Ported from
// legacy refreshEnvChip().
export function EnvChip() {
  const { data, isError } = useQuery({
    queryKey: ["setup"],
    queryFn: () => api("/api/setup"),
    staleTime: 60_000
  });

  const env = String(data?.environment || "local").toLowerCase();
  const host =
    data?.hostname ||
    (data?.baseUrl ? safeHost(data.baseUrl) : isError ? "unknown" : "local");

  useEffect(() => {
    if (host && host !== "unknown") {
      document.title = `${host} · ${env} — ${data?.instanceName || "Runyard"}`;
    }
  }, [host, env, data?.instanceName]);

  const loading = !data && !isError;
  return (
    <span
      className={`env-chip${loading ? " env-chip-loading" : ""}`}
      data-env={loading ? undefined : env}
      aria-label="Connected hub"
      title={loading ? "Which Runyard hub you are connected to" : `Connected to ${host} (${env})`}
    >
      <span className="env-chip-dot" aria-hidden="true" />
      <span className="env-chip-host">{loading ? "connecting…" : host}</span>
      <span className="env-chip-tag">{loading ? "" : env}</span>
    </span>
  );
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "local";
  }
}
