import { useEffect, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { runsCollection, runnersCollection, capabilitiesCollection } from "../lib/collections.js";
import { api } from "../lib/api.js";
import { useHashRoute, useNavigate, deepLinks } from "../lib/router.js";
import { useNow } from "../lib/storage.js";
import {
  isActiveRun, isUnresolvedFailure, topLevelRuns, supervisedChildRuns,
  timeRangeToSinceISO, truncate, RUN_STATUS_OPTIONS, TIME_RANGE_OPTIONS
} from "../lib/runHelpers.js";
import { peekRerunDraft, clearRerunDraft } from "../lib/runActions.js";
import { RunCard } from "../components/RunCard.jsx";
import { PrimaryActionBar, IncidentCard, HomeStatStrip } from "../components/HomeChrome.jsx";
import { ApprovalList } from "../components/ApprovalList.jsx";
import { relativeTime } from "../lib/format.js";

const DEFAULT_HIDDEN_WORKFLOWS = ["runyard-support-agent", "reauth-cli"];

function parseWorkflowParam(value = "") {
  return [...new Set(String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean))];
}

function workflowParamFromParams(params) {
  if (params.has("workflows")) return params.get("workflows") || "";
  if (params.has("capabilities")) return params.get("capabilities") || "";
  if (params.has("capability")) return params.get("capability") || "";
  return null;
}

function defaultWorkflowSlugs(capabilities = []) {
  return capabilities
    .map((cap) => cap.slug)
    .filter(Boolean)
    .filter((slug) => !DEFAULT_HIDDEN_WORKFLOWS.includes(slug));
}

function sortedWorkflowOptions(capabilities = []) {
  return [...capabilities]
    .filter((cap) => cap?.slug)
    .sort((a, b) => {
      const ah = DEFAULT_HIDDEN_WORKFLOWS.includes(a.slug) ? 1 : 0;
      const bh = DEFAULT_HIDDEN_WORKFLOWS.includes(b.slug) ? 1 : 0;
      if (ah !== bh) return ah - bh;
      return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
    });
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

function filtersFromParams(params) {
  const workflowParam = workflowParamFromParams(params);
  return {
    q: params.get("q") || "",
    status: params.get("status") || "",
    range: params.get("range") || "",
    cursor: params.get("cursor") || "",
    workflows: workflowParam == null ? undefined : parseWorkflowParam(workflowParam)
  };
}

function filtersToQuery(filters) {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.status) p.set("status", filters.status);
  if (filters.range) p.set("range", filters.range);
  if (Array.isArray(filters.workflows)) p.set("workflows", filters.workflows.join(","));
  if (filters.cursor) p.set("cursor", filters.cursor);
  return p.toString();
}

function HomeFilterBar({ filters, capabilities = [], matchingCount = 0 }) {
  const navigate = useNavigate();
  const workflowOptions = sortedWorkflowOptions(capabilities);
  const defaultWorkflows = defaultWorkflowSlugs(capabilities);
  const selectedWorkflows = Array.isArray(filters.workflows) ? filters.workflows : defaultWorkflows;
  const workflowFilterKey = Array.isArray(filters.workflows) ? filters.workflows.join(",") : "";
  const [q, setQ] = useState(filters.q);
  const [status, setStatus] = useState(filters.status);
  const [range, setRange] = useState(filters.range);
  const [workflows, setWorkflows] = useState(selectedWorkflows);
  useEffect(() => {
    setQ(filters.q);
    setStatus(filters.status);
    setRange(filters.range);
    setWorkflows(Array.isArray(filters.workflows) ? filters.workflows : defaultWorkflows);
  }, [filters.q, filters.status, filters.range, workflowFilterKey, defaultWorkflows.join(",")]);

  function apply(next) {
    const nextWorkflows = next && Object.hasOwn(next, "workflows") ? next.workflows : workflows;
    const merged = {
      q,
      status,
      range,
      cursor: "",
      ...next,
      workflows: sameSet(nextWorkflows, defaultWorkflows) ? undefined : nextWorkflows
    };
    const query = filtersToQuery(merged);
    navigate(`#runs${query ? `?${query}` : ""}`);
  }
  function toggleWorkflow(slug) {
    setWorkflows((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  }
  const activeChips = [];
  if (filters.q) activeChips.push({ kind: "q", label: `“${truncate(filters.q, 24)}”` });
  if (filters.status) activeChips.push({ kind: "status", label: `status: ${filters.status}` });
  if (filters.range) {
    const rl = (TIME_RANGE_OPTIONS.find((o) => o.value === filters.range) || {}).label || filters.range;
    activeChips.push({ kind: "range", label: rl });
  }
  if (Array.isArray(filters.workflows)) activeChips.push({ kind: "workflows", label: `${filters.workflows.length} workflow${filters.workflows.length === 1 ? "" : "s"}` });
  const active = Boolean(filters.q || filters.status || filters.range || filters.cursor || Array.isArray(filters.workflows));

  return (
    <section className="runs-filter-panel" aria-label="Runs search and filters">
      <div className="runs-filter-heading">
        <h2>Search runs</h2>
        {active ? (
          <span className="runs-filter-count" aria-live="polite">{matchingCount} matching</span>
        ) : null}
      </div>
      <form
        className="runs-filter-bar"
        id="runs-filter-bar"
        role="search"
        aria-label="Filter runs"
        onSubmit={(e) => { e.preventDefault(); apply(); }}
      >
        <label><span className="muted">Search</span>
          <input type="search" id="runs-filter-q" name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="workflow, step, error, run id" autoComplete="off" />
        </label>
        <label><span className="muted">Status</span>
          <select id="runs-filter-status" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {RUN_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label><span className="muted">Time</span>
          <select id="runs-filter-range" name="range" value={range} onChange={(e) => setRange(e.target.value)}>
            {TIME_RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {workflowOptions.length ? (
          <fieldset className="runs-workflow-filter">
            <legend className="muted">Workflows</legend>
            <div className="runs-workflow-filter-list">
              {workflowOptions.map((cap) => (
                <label key={cap.slug} className="runs-workflow-filter-option">
                  <input
                    type="checkbox"
                    checked={workflows.includes(cap.slug)}
                    onChange={() => toggleWorkflow(cap.slug)}
                  />
                  <span>{cap.name || cap.slug}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <button type="submit" className="button">Apply</button>
        <button type="button" className="button" id="runs-filter-clear" disabled={!active} onClick={() => navigate("#runs")}>Clear</button>
        {activeChips.length ? (
          <div className="runs-filter-chips" aria-label="Active filters">
            {activeChips.map((c) => (
              <span className="runs-filter-chip" data-filter-chip={c.kind} key={c.kind}>
                {c.label}{" "}
                <button type="button" aria-label={`Clear ${c.kind} filter`} data-clear-filter={c.kind} onClick={() => apply(c.kind === "workflows" ? { workflows: defaultWorkflows } : { [c.kind]: "" })}>×</button>
              </span>
            ))}
          </div>
        ) : null}
      </form>
    </section>
  );
}

function RerunDraftBanner({ draft, onDiscard }) {
  const navigate = useNavigate();
  if (!draft) return null;
  return (
    <div className="rerun-draft-banner" role="status">
      <span>Draft re-run for <strong>{draft.capabilitySlug}</strong> saved {relativeTime(draft.at)}.</span>
      <div className="toolbar-actions">
        <button className="button primary" onClick={() => navigate(deepLinks.workflowRun(draft.capabilitySlug))}>Resume</button>
        <button className="button" onClick={() => { clearRerunDraft(); onDiscard(); }}>Discard</button>
      </div>
    </div>
  );
}

export function Home() {
  const route = useHashRoute();
  const navigate = useNavigate();
  const filters = filtersFromParams(route.params);
  const filtersActive = Boolean(filters.q || filters.status || filters.range || filters.cursor || Array.isArray(filters.workflows));
  const now = useNow(1000, true);
  const [draftTick, setDraftTick] = useState(0);

  // Live, reactive collections — replace the legacy 30s/4s setInterval polls.
  const { data: liveRuns = [] } = useLiveQuery((q) => runsCollection);
  const { data: runners = [] } = useLiveQuery((q) => runnersCollection);
  const { data: capabilities = [] } = useLiveQuery((q) => capabilitiesCollection);

  const dashQ = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api("/api/dashboard"),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev
  });
  const artifactsQ = useQuery({ queryKey: ["artifacts"], queryFn: () => api("/api/artifacts"), staleTime: 30_000 });

  // Filtered view fetches with params (and still polls); unfiltered uses the
  // live collection so the dashboard updates reactively.
  const filteredQ = useQuery({
    queryKey: ["runs", "filtered", filters],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("limit", "30");
      if (filters.q) p.set("q", filters.q);
      if (filters.status) p.set("status", filters.status);
      if (Array.isArray(filters.workflows)) p.set("workflows", filters.workflows.join(","));
      const since = timeRangeToSinceISO(filters.range);
      if (since) p.set("since", since);
      if (filters.cursor) p.set("cursor", filters.cursor);
      return api(`/api/runs?${p.toString()}`);
    },
    enabled: filtersActive,
    refetchInterval: 5_000,
    placeholderData: (prev) => prev
  });

  const runs = filtersActive ? filteredQ.data?.runs || [] : liveRuns;
  const totalMatching = filtersActive
    ? typeof filteredQ.data?.total === "number" ? filteredQ.data.total : runs.length
    : runs.length;
  const nextCursor = filtersActive ? filteredQ.data?.nextCursor || "" : "";

  const draft = (() => { void draftTick; return peekRerunDraft(); })();

  // First-run gate → onboarding wizard (once per session). Only for a GENUINELY
  // fresh hub: wait until the dashboard fetch has settled, otherwise the empty
  // initial live-collections race the load and wrongly bounce a populated
  // deployment (existing runs/runners) into the wizard during the load window.
  useEffect(() => {
    if (filtersActive) return;
    if (!dashQ.isSuccess) return;
    if (runners.length || runs.length) return;
    if ((dashQ.data?.recentRuns?.length || 0) > 0) return;
    if (sessionStorage.getItem("onboardingSkipped")) return;
    if (location.hash === "#runs" || location.hash === "#home") return;
    navigate("#onboarding");
  }, [filtersActive, dashQ.isSuccess, dashQ.data, runners.length, runs.length, navigate]);

  const visibleRuns = filtersActive ? runs : topLevelRuns(runs);
  const hiddenSupervised = filtersActive ? [] : supervisedChildRuns(runs);
  const active = visibleRuns.filter(isActiveRun);
  const completed = visibleRuns.filter((r) => !isActiveRun(r));

  const cutoff = now - 24 * 3600 * 1000;
  const recentlyFailed = visibleRuns.filter((r) => {
    if (!isUnresolvedFailure(r)) return false;
    const t = Date.parse(r.completedAt || r.createdAt || "");
    return Number.isNaN(t) ? true : t >= cutoff;
  });
  const failed24h = recentlyFailed.length;
  const lastFailedRun = recentlyFailed[0] || visibleRuns.find(isUnresolvedFailure) || null;
  const onlineRunners = runners.filter((r) => r.online).length;

  const artifactsByRun = new Map();
  for (const a of artifactsQ.data?.artifacts || []) {
    if (!artifactsByRun.has(a.runId)) artifactsByRun.set(a.runId, []);
    artifactsByRun.get(a.runId).push(a);
  }

  const stats = dashQ.data?.stats || {};
  const pool = dashQ.data?.pool || null;
  const pending = dashQ.data?.pendingApprovals || [];
  const queued = stats.queuedRuns != null ? stats.queuedRuns : runs.filter((r) => r.status === "queued").length;
  const capacityLabel = pool && pool.totalCapacity
    ? `${pool.totalActive}/${pool.totalCapacity} slots`
    : `${stats.runnerActiveSlots ?? 0}/${stats.runnerCapacity ?? 0} slots`;
  const gettingStarted = !filtersActive && runs.length === 0 && !active.length;

  return (
    <>
      {lastFailedRun ? (
        <IncidentCard run={lastFailedRun} failed24h={failed24h} onlineRunners={onlineRunners} />
      ) : (
        <PrimaryActionBar runners={runners} capabilities={capabilities} />
      )}
      <RerunDraftBanner draft={draft} onDiscard={() => setDraftTick((n) => n + 1)} />
      <HomeFilterBar filters={filters} capabilities={capabilities} matchingCount={totalMatching} />
      {gettingStarted ? (
        <div className="empty empty-runs" role="region" aria-label="No runs yet">
          <p className="empty-runs-headline"><strong>No runs yet</strong></p>
          <p className="muted">Workflows you trigger will appear here with logs, artifacts, and re-run controls. Start with the quickstart, or pick a workflow to launch.</p>
          {/* The PrimaryActionBar above owns the one primary action on this
              view, so these onboarding shortcuts stay secondary. */}
          <div className="empty-runs-actions">
            <a className="button" href="/docs#quickstart">Open quickstart</a>
            <button type="button" className="button" onClick={() => navigate("#workflows")}>Pick a workflow</button>
          </div>
        </div>
      ) : null}
      <HomeStatStrip active={active} queued={queued} capacityLabel={capacityLabel} stats={stats} runs={runs} pending={pending} pool={pool} />

      {!filtersActive && active.length ? (
        <>
          <h2 className="section-heading in-flight-heading">In flight <span className="muted">{active.length} live</span></h2>
          <section className="run-grid live in-flight">
            {active.map((run) => <RunCard key={run.id} run={run} artifacts={artifactsByRun.get(run.id) || []} now={now} />)}
          </section>
        </>
      ) : null}

      {filtersActive ? (
        <>
          <h2 className="section-heading">Matching runs <span className="muted">{totalMatching} total</span></h2>
          {runs.length ? (
            <section className="run-history-list">
              {runs.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  artifacts={artifactsByRun.get(run.id) || []}
                  now={now}
                  variant={isActiveRun(run) ? "card" : "row"}
                />
              ))}
            </section>
          ) : (
            <p className="muted">No runs match the current filters. <a href="#runs">Clear filters</a> to see everything.</p>
          )}
          {(filters.cursor || nextCursor) ? (
            <nav className="runs-pagination" aria-label="Run history pagination">
              <p className="muted">{`Showing ${runs.length} of ${totalMatching} matching run${totalMatching === 1 ? "" : "s"}`}</p>
              <div className="toolbar-actions">
                {filters.cursor ? <a className="button" href={`#runs?${filtersToQuery({ ...filters, cursor: "" })}`}>First page</a> : null}
                {nextCursor ? <a className="button primary" href={`#runs?${filtersToQuery({ ...filters, cursor: nextCursor })}`}>Next page →</a> : null}
              </div>
            </nav>
          ) : null}
        </>
      ) : (
        <>
          <h2 className="section-heading">Recent &amp; completed</h2>
          {hiddenSupervised.length ? (
            <p className="supervised-child-summary muted">
              {hiddenSupervised.length} supervised child attempt{hiddenSupervised.length === 1 ? "" : "s"} hidden from this top-level view. Open the parent run to inspect wrapper retries and repair lineage.
            </p>
          ) : null}
          {completed.length ? (
            <section className="run-history-list">
              {completed.slice(0, 30).map((run) => <RunCard key={run.id} run={run} artifacts={artifactsByRun.get(run.id) || []} now={now} variant="row" />)}
            </section>
          ) : (
            <p className="muted">Completed runs and their artifacts will appear here.</p>
          )}
        </>
      )}

      {pending.length ? (
        <>
          <h2 className="section-heading">Pending approvals</h2>
          <section className="panel"><ApprovalList approvals={pending} /></section>
        </>
      ) : null}
    </>
  );
}
