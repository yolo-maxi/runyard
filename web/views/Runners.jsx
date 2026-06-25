import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { runnersCollection, refreshCollection } from "../lib/collections.js";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { useNow } from "../lib/storage.js";
import { relativeTime } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { Toolbar, StatusBadge, Icon } from "../components/ui.jsx";

// Runners view. Ported from legacy renderRunners(). The live runners list comes
// from runnersCollection (polls every 30s) so heartbeat rows re-paint without a
// manual loop; useNow() ticks each second so freshness recolors live. Pool
// stats aren't on the collection, so a plain useQuery reads `.pool` alongside.

// Capacity cell — mirrors legacy runnerCapacityCell().
function RunnerCapacityCell({ runner }) {
  const capacity = Number(runner.capacity || 1);
  const active = Number(runner.activeRuns || 0);
  const saturated = capacity > 0 && active >= capacity;
  const slots = [];
  for (let i = 0; i < capacity; i += 1) {
    slots.push(<span key={i} className={`runner-slot ${i < active ? "filled" : "free"}`} aria-hidden="true" />);
  }
  return (
    <span className={`runner-capacity ${saturated ? "saturated" : ""}`} title={`${active} active of ${capacity} slots`}>
      <span className="runner-capacity-count">{active} / {capacity}</span>
      <span className="runner-slots" aria-label={`${active} of ${capacity} slots filled`}>{slots}</span>
    </span>
  );
}

// Heartbeat freshness cell: <30s green (ok), <2m amber (warn), else red (danger).
// Absolute timestamp stays as a tooltip for log forensics.
function HeartbeatCell({ iso, now }) {
  if (!iso) return <span className="muted">never</span>;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return <>{iso}</>;
  const ageMs = now - t;
  const tone = ageMs <= 30_000 ? "ok" : ageMs <= 120_000 ? "warn" : "danger";
  return <span className={`hb-cell hb-${tone}`} title={iso}>{relativeTime(iso, now)}</span>;
}

// Pool summary chips — mirrors legacy renderRunnerPoolSummary() with the
// "runners-admin" context (keeps the capacity chip).
function RunnerPoolSummary({ pool }) {
  if (!pool) return null;
  const queued = pool.queued || 0;
  const capacity = pool.totalCapacity || 0;
  const active = pool.totalActive || 0;
  const available = pool.availableSlots != null ? pool.availableSlots : Math.max(0, capacity - active);
  return (
    <p className="runner-pool-summary">
      {queued ? (
        <span className="chip chip-queue" title="Runs waiting for a free runner slot"><Icon name="queue" /> {queued} queued</span>
      ) : (
        <span className="chip chip-queue empty" title="Queue is empty"><Icon name="queue" /> queue empty</span>
      )}
      <span className="chip chip-runner" title="Active slots / total capacity across online runners"><Icon name="runner" /> {active} / {capacity} slots</span>
      <span className={`chip ${available ? "chip-branch" : "chip-version"}`} title="Free slots across the pool"><Icon name="free" /> {available} free</span>
    </p>
  );
}

const EMPTY_DETAIL = "—";

function RunnerDetailRow({ runner }) {
  const tags = (runner.tags || []).join(", ");
  return (
    <tr className="runner-detail-row">
      <td colSpan={8}>
        <dl className="runner-detail-grid">
          <dt>Runner ID</dt><dd><code>{runner.id}</code></dd>
          <dt>Hostname</dt><dd>{runner.hostname || EMPTY_DETAIL}</dd>
          <dt>Platform</dt><dd>{runner.platform || EMPTY_DETAIL}</dd>
          <dt>Version</dt><dd>{runner.version || EMPTY_DETAIL}</dd>
          <dt>Tags</dt><dd>{tags || EMPTY_DETAIL}</dd>
          <dt>Created</dt><dd>{runner.createdAt || EMPTY_DETAIL}</dd>
          <dt>Last heartbeat</dt><dd>{runner.lastHeartbeatAt || "never"}</dd>
          <dt>Current run</dt>
          <dd>
            {runner.currentRunId ? (
              <a href={deepLinks.run(runner.currentRunId)}>{runner.currentRunId}</a>
            ) : (
              <span className="muted">idle</span>
            )}
          </dd>
        </dl>
      </td>
    </tr>
  );
}

function RunnerRow({ runner, now, expanded, onToggle, onPing }) {
  const [pinging, setPinging] = useState(false);
  const platformOrHost = runner.platform || runner.hostname;

  async function ping() {
    setPinging(true);
    try {
      await onPing();
      toast(`Refreshed heartbeat for ${runner.id}`, "ok");
    } catch (error) {
      toast(error.message || "Refresh failed", "error");
    } finally {
      setPinging(false);
    }
  }

  return (
    <>
      <tr id={`runner-row-${runner.id}`}>
        <td data-label="Name">{runner.name}<br /><span className="muted">{runner.id}</span></td>
        <td data-label="Status"><StatusBadge value={runner.online ? "online" : "offline"} /></td>
        <td data-label="Capacity"><RunnerCapacityCell runner={runner} /></td>
        <td data-label="Version">{runner.version ? <code>{runner.version}</code> : <span className="muted">unknown</span>}</td>
        <td data-label="OS · host">
          {platformOrHost ? (
            <>{runner.platform || "?"} · <span className="muted">{runner.hostname || "?"}</span></>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td data-label="Tags">{(runner.tags || []).join(", ")}</td>
        <td data-label="Last seen"><HeartbeatCell iso={runner.lastHeartbeatAt} now={now} /></td>
        <td data-label="Actions">
          <button className="button" title="Refresh heartbeat reading" disabled={pinging} onClick={ping}>Send test ping</button>{" "}
          <button className="button" aria-expanded={expanded ? "true" : "false"} onClick={onToggle}>Details</button>
        </td>
      </tr>
      {expanded ? <RunnerDetailRow runner={runner} /> : null}
    </>
  );
}

const TABLE_HEAD = (
  <thead>
    <tr>
      <th>Name</th><th>Status</th><th>Capacity</th><th>Version</th>
      <th>OS · host</th><th>Tags</th><th>Last seen</th><th></th>
    </tr>
  </thead>
);

function RunnersTable({ list, now, expanded, toggle, refresh }) {
  return (
    <table className="table runners-table">
      {TABLE_HEAD}
      <tbody>
        {list.map((runner) => (
          <RunnerRow
            key={runner.id}
            runner={runner}
            now={now}
            expanded={Boolean(expanded[runner.id])}
            onToggle={() => toggle(runner.id)}
            onPing={refresh}
          />
        ))}
      </tbody>
    </table>
  );
}

export function Runners() {
  const now = useNow(1000, true);
  const [expanded, setExpanded] = useState({});
  const [showOffline, setShowOffline] = useState(false);

  const { data: runners = [] } = useLiveQuery((q) => runnersCollection);
  const poolQ = useQuery({
    queryKey: ["runners-pool"],
    queryFn: () => api("/api/runners"),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev
  });
  const pool = poolQ.data?.pool || null;

  // "Send test ping" / refresh — no bespoke ping endpoint exists; re-fetching
  // the runners list re-paints heartbeat freshness with the latest reading.
  const refresh = () => refreshCollection("runners");

  const toggle = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const online = runners.filter((r) => r.online);
  const offline = runners.filter((r) => !r.online);

  return (
    <>
      <Toolbar title="Runners" shareHash={deepLinks.runners()} />
      <section className="panel">
        <RunnerPoolSummary pool={pool} />
        {!runners.length ? (
          <div className="empty">
            <p>No runners connected.</p>
            <p className="muted">
              Start one with <code>runyard-runner</code> using a token that has the runner scope. Set <code>SMITHERS_RUNNER_CONCURRENCY=4</code> on a dedicated pool host for ~4 concurrent jobs.
            </p>
          </div>
        ) : (
          <>
            {online.length ? (
              <RunnersTable list={online} now={now} expanded={expanded} toggle={toggle} refresh={refresh} />
            ) : (
              <div className="empty">
                <p>No online runners.</p>
                {offline.length ? <p className="muted">All connected runners are offline. Expand the offline list below or start a runner.</p> : null}
              </div>
            )}
            {offline.length ? (
              <div className="runners-offline">
                <button className="button" aria-expanded={showOffline ? "true" : "false"} onClick={() => setShowOffline((v) => !v)}>
                  {showOffline ? `Hide ${offline.length} offline` : `Show ${offline.length} offline`}
                </button>
                <div className={showOffline ? "" : "hidden"}>
                  <RunnersTable list={offline} now={now} expanded={expanded} toggle={toggle} refresh={refresh} />
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
