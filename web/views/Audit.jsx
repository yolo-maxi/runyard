import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { Toolbar } from "../components/ui.jsx";

// Security audit trail (admin). Ported from renderAudit().
export function Audit() {
  const { data, error, isLoading } = useQuery({ queryKey: ["audit"], queryFn: () => api("/api/audit"), retry: false });

  if (error) {
    return (
      <>
        <Toolbar title="Audit Log" shareHash={deepLinks.audit()} />
        <section className="panel"><p className="muted">{error.message} (admin scope required)</p></section>
      </>
    );
  }
  const rows = data?.audit || [];
  return (
    <>
      <Toolbar title="Audit Log" shareHash={deepLinks.audit()} />
      <section className="panel">
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : rows.length ? (
          <table className="table">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>
              {rows.map((entry, i) => (
                <tr key={entry.id ?? i}>
                  <td data-label="Time">{entry.createdAt}</td>
                  <td data-label="Actor">{entry.actor}</td>
                  <td data-label="Action">{entry.action}</td>
                  <td data-label="Target"><span className="muted">{entry.target || ""}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No audit entries yet.</p>
        )}
      </section>
    </>
  );
}
