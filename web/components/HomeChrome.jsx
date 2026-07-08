import { summarizeFailure } from "../lib/runHelpers.js";
import { deepLinks } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";
import { rerunRun } from "../lib/runActions.js";
import { Icon } from "./ui.jsx";

// Recommended-next-action bar shown when there's no unresolved failure.
// Ported from primaryActionBar().
export function PrimaryActionBar({ runners = [], capabilities = [] }) {
  const onlineRunners = runners.filter((r) => r.online).length;
  let tone = "primary";
  let headline = "Ready to run";
  let sub = "Everything is wired up — trigger a run, or check on the fleet.";
  let primary = { label: "Trigger run", href: "#workflows" };
  let secondary = [{ label: "View runners", href: "#runners" }];
  if (!runners.length) {
    tone = "warn";
    headline = "Connect your first runner";
    sub = "A runner executes workflows on a machine you control. Without one, queued work can't move.";
    primary = { label: "Connect a runner", href: "#onboarding" };
    secondary = [{ label: "Read the quickstart", href: "/docs#quickstart" }];
  } else if (!capabilities.length) {
    headline = "Publish your first workflow";
    sub = "Workflows are the actions agents and humans can trigger. Start from a template.";
    primary = { label: "Publish a workflow", href: "#workflows" };
    secondary = [{ label: "Browse templates", href: "#workflows" }];
  } else if (onlineRunners === 0) {
    tone = "warn";
    headline = "No active runners";
    sub = "Queued work waits until a runner reconnects. Runs that already finished are unaffected.";
    primary = { label: "View runner health", href: "#runners" };
    secondary = [{ label: "Start a runner", href: "#onboarding" }];
  }
  return (
    <section className="primary-action-bar" data-tone={tone} role="region" aria-label="Recommended next action">
      <div className="primary-action-headline">
        <span>{headline}</span>
        <small>{sub}</small>
      </div>
      <div className="primary-action-actions">
        <a className="button primary" href={primary.href} id="pab-trigger">{primary.label}</a>
        {secondary.map((link) => (
          <a key={link.href} className="primary-action-secondary" href={link.href}>{link.label}</a>
        ))}
      </div>
    </section>
  );
}

function IncidentCopy({ value, what }) {
  return (
    <button type="button" className="incident-copy" title={`Copy ${what}`} aria-label={`Copy ${what}`} onClick={() => copyText(value, "Copied")}>
      ⧉
    </button>
  );
}

// Replaces the action bar whenever there's an unresolved failed run. Ported
// from incidentCard(). Open by default only when blocking (no online runner).
export function IncidentCard({ run, failed24h = 1, onlineRunners = 0 }) {
  if (!run) return null;
  const f = summarizeFailure(run);
  const blocking = onlineRunners === 0;
  const impact = blocking
    ? "Blocking — no active runner is available to re-run it."
    : failed24h > 1
      ? `Not blocking — new runs can still start. ${failed24h} failures in the last 24h.`
      : "Not blocking — new runs can still start.";
  return (
    <details className="incident-card" data-tone="danger" open={blocking}>
      <summary className="incident-summary" aria-label="Most recent failure">
        <span className="incident-cause-label">{f.label}</span>
        <span className="incident-impact">{impact}</span>
      </summary>
      <div className="incident-body">
        <p className="incident-sentence">{f.sentence}</p>
        <div className="incident-actions">
          <a className="button primary" href={deepLinks.runLogs(run.id)}>Inspect failure</a>
          <button type="button" className="button" onClick={() => rerunRun(run.id)}>Re-run with same input</button>
          <a className="button ghost" href={deepLinks.run(run.id)}>Open run</a>
        </div>
        <dl className="incident-tech-grid incident-tech">
          <div><dt>Run</dt><dd><code>{run.id}</code> <IncidentCopy value={run.id} what="run id" /></dd></div>
          {f.step ? <div><dt>Step</dt><dd><code>{f.step}</code></dd></div> : null}
          {f.runnerId ? <div><dt>Runner</dt><dd><code>{f.runnerId}</code></dd></div> : null}
          {f.raw ? <div className="incident-tech-raw"><dt>Error</dt><dd><code>{f.raw}</code> <IncidentCopy value={f.raw} what="error text" /></dd></div> : null}
        </dl>
      </div>
    </details>
  );
}

// Compact totals strip. Ported from renderHomeStatStrip().
export function HomeStatStrip({ active, queued, capacityLabel, stats, runs, pending, pool }) {
  const available = pool
    ? pool.availableSlots != null
      ? pool.availableSlots
      : Math.max(0, (pool.totalCapacity || 0) - (pool.totalActive || 0))
    : null;
  const items = [
    { v: active.length, label: "active", title: "Runs in flight right now", hot: active.length > 0 },
    { v: queued, label: "queued", title: "Runs waiting for a free slot", icon: "queue", hot: queued > 0 },
    { v: capacityLabel, label: "", title: "Active slots / total runner capacity", icon: "runner" },
    available != null ? { v: available, label: "free", title: "Free runner slots", icon: "free" } : null,
    { v: stats.capabilities ?? 0, label: "workflows", title: "Workflows defined" },
    { v: stats.runs ?? runs.length, label: "total", title: "Total runs" },
    { v: stats.artifacts ?? 0, label: "artifacts", title: "Artifacts stored" },
    { v: pending.length, label: "approvals", title: "Pending approvals", hot: pending.length > 0 }
  ].filter(Boolean);
  return (
    <div className="home-stat-strip" aria-label="Hub totals">
      {items.map((it, i) => (
        <span key={i} className={`hstat${it.hot ? " hot" : ""}`} title={it.title}>
          {it.icon ? <Icon name={it.icon} /> : null}
          <strong>{String(it.v)}</strong>
          {it.label ? <> <span className="hstat-label">{it.label}</span></> : null}
        </span>
      ))}
    </div>
  );
}
