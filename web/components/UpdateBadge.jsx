import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { meIsAdmin } from "../lib/me.js";
import { toast } from "../lib/toast.js";

// Admin-only topbar pill surfacing a passive, server-side update check
// (/api/update-status, hourly server-side; refetched here every 60s). Shows a
// failed/rolled-back outcome first, then "Update available → vX". Clicking
// applies when UPDATE_APPLY_ENABLED, else explains the host command. Ported
// from refreshUpdateBadge()/bindUpdateBadgeOnce().
export function UpdateBadge({ me }) {
  const admin = meIsAdmin(me);
  const { data } = useQuery({
    queryKey: ["update-status"],
    queryFn: () => api("/api/update-status"),
    enabled: admin,
    refetchInterval: 60_000,
    retry: false
  });
  if (!admin || !data) return null;

  const outcome = data.lastOutcome;
  if (outcome && outcome.level === "error") {
    return (
      <button
        type="button"
        className="update-badge"
        data-tone="danger"
        title={outcome.message || "Update failed — see Audit/logs."}
      >
        ⚠ {outcome.title || "Update failed"}
      </button>
    );
  }
  if (!(data.updateAvailable && data.latest)) return null;

  async function onClick() {
    if (!data.applyEnabled) {
      window.alert(
        `A newer release (v${data.latest}) is available.\n\nApply it on the host with:\n    runyard update\n\n(HTTP-triggered apply is disabled. Set UPDATE_APPLY_ENABLED=1 on the hub to enable an Apply button.)`
      );
      return;
    }
    if (!window.confirm(`Apply update to v${data.latest} now? Runners drain first, then the hub restarts.`)) return;
    try {
      await api("/api/update/apply", { method: "POST", body: { tag: data.latestTag || `v${data.latest}` } });
      toast("Update started: draining runners, then restarting…", "ok");
    } catch (error) {
      window.alert(`Could not start update: ${error.message}`);
    }
  }

  return (
    <button
      type="button"
      className="update-badge"
      data-tone="update"
      title={`Running v${data.current}${data.gitTag ? ` (${data.gitTag})` : ""} · latest v${data.latest}. ${data.applyEnabled ? "Click to apply." : "Run `runyard update` on the host to apply."}`}
      onClick={onClick}
    >
      Update available → v{data.latest}
    </button>
  );
}
