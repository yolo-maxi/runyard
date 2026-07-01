import { useEffect, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { runsCollection, runnersCollection, capabilitiesCollection } from "../lib/collections.js";
import { api } from "../lib/api.js";
import { useHashRoute, useNavigate, deepLinks } from "../lib/router.js";
import { useNow, useLocalStorage } from "../lib/storage.js";
import {
  topLevelRuns, supervisedChildRuns,
  timeRangeToSinceISO, truncate, RUN_STATUS_OPTIONS, TIME_RANGE_OPTIONS
} from "../lib/runHelpers.js";
import { groupRunsByEndedDate } from "../lib/runGrouping.js";
import { peekRerunDraft, clearRerunDraft } from "../lib/runActions.js";
import { RunCard } from "../components/RunCard.jsx";
import { relativeTime } from "../lib/format.js";

// Workflow slugs that are operationally internal — support agents, reauth helpers,
// etc. They're real runs but they bury the actual operator workload, so the #runs
// view hides them by default and exposes a single chip to flip them back on.
const DEFAULT_HIDDEN_WORKFLOWS = ["runyard-support-agent", "reauth-cli"];
const SHOW_INTERNAL_STORAGE_KEY = "runs.showInternalWorkflows";
const WORKFLOW_FILTER_OPEN_STORAGE_KEY = "runs.workflowFilterOpen";

function isInternalRun(run) {
  return DEFAULT_HIDDEN_WORKFLOWS.includes(run?.capabilitySlug || "");
}

function parseWorkflowParam(value = "") {
  return [...new Set(String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean))];
}

function workflowParamFromParams(params) {
  if (params.has("workflows")) return params.get("workflows") || "";
  if (params.has("capabilities")) return params.get("capabilities") || "";
  if (params.has("capability")) return params.get("capability") || "";
  return null;
}

function defaultWorkflowSlugs(capabilities = [], { includeInternal = false } = {}) {
  return capabilities
    .map((cap) => cap.slug)
    .filter(Boolean)
    .filter((slug) => includeInternal || !DEFAULT_HIDDEN_WORKFLOWS.includes(slug));
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
  const order = params.get("order") === "asc" ? "asc" : "desc";
  return {
    q: params.get("q") || "",
    status: params.get("status") || "",
    range: params.get("range") || "",
    order,
    cursor: params.get("cursor") || "",
    workflows: workflowParam == null ? undefined : parseWorkflowParam(workflowParam)
  };
}

function filtersToQuery(filters) {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.status) p.set("status", filters.status);
  if (filters.range) p.set("range", filters.range);
  if (filters.order === "asc") p.set("order", "asc");
  if (Array.isArray(filters.workflows)) p.set("workflows", filters.workflows.join(","));
  if (filters.cursor) p.set("cursor", filters.cursor);
  return p.toString();
}

function RunHistoryGroups({ groups, artifactsByRun, now }) {
  // Active and historical runs share the same row chrome; only the status badge
  // and accent stripe distinguish them. This keeps the table dense and scannable.
  return (
    <section className="run-history-list">
      {groups.map((group) => (
        <div className="run-history-day" key={group.key}>
          <div className="run-history-day-separator" role="heading" aria-level="3">
            <span>{group.label}</span>
          </div>
          <div className="run-history-day-runs">
            {group.runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                artifacts={artifactsByRun.get(run.id) || []}
                now={now}
                variant="row"
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function HomeFilterBar({ filters, capabilities = [], matchingCount = 0, showInternal, onToggleInternal, internalHiddenCount = 0, statusCounts = {} }) {
  const navigate = useNavigate();
  const workflowOptions = sortedWorkflowOptions(capabilities);
  const defaultWorkflows = defaultWorkflowSlugs(capabilities, { includeInternal: showInternal });
  const selectedWorkflows = Array.isArray(filters.workflows) ? filters.workflows : defaultWorkflows;
  const workflowFilterKey = Array.isArray(filters.workflows) ? filters.workflows.join(",") : "";
  const [q, setQ] = useState(filters.q);
  const [status, setStatus] = useState(filters.status);
  const [range, setRange] = useState(filters.range);
  const [order, setOrder] = useState(filters.order);
  const [workflows, setWorkflows] = useState(selectedWorkflows);
  // Persist open/closed for the workflow popover so heavy filter setups don't
  // re-collapse on every navigation. Default closed to keep the toolbar tight.
  const [workflowPanelOpen, setWorkflowPanelOpen] = useLocalStorage(WORKFLOW_FILTER_OPEN_STORAGE_KEY, false);
  useEffect(() => {
    setQ(filters.q);
    setStatus(filters.status);
    setRange(filters.range);
    setOrder(filters.order);
    setWorkflows(Array.isArray(filters.workflows) ? filters.workflows : defaultWorkflows);
  }, [filters.q, filters.status, filters.range, filters.order, workflowFilterKey, defaultWorkflows.join(",")]);

  function apply(next) {
    const nextWorkflows = next && Object.hasOwn(next, "workflows") ? next.workflows : workflows;
    const merged = {
      q,
      status,
      range,
      order,
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
  if (filters.order === "asc") activeChips.push({ kind: "order", label: "oldest first" });
  if (Array.isArray(filters.workflows)) activeChips.push({ kind: "workflows", label: `${filters.workflows.length} workflow${filters.workflows.length === 1 ? "" : "s"}` });

  // Compact panel: drop the standalone heading row and put the "show support runs"
  // toggle inline next to the filter chips. Reclaims ~36px above the table.
  return (
    <section className="runs-filter-panel" aria-label="Runs search and filters">
      <form
        className="runs-filter-bar"
        id="runs-filter-bar"
        role="search"
        aria-label="Filter runs"
        onSubmit={(e) => { e.preventDefault(); apply(); }}
      >
        {/* Visible field labels are dropped — the placeholder / selected
            option carries the meaning, and each control keeps an aria-label
            so screen readers still announce it. */}
        <input type="search" id="runs-filter-q" name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="workflow, step, error, run id" autoComplete="off" aria-label="Search runs" />
        <select id="runs-filter-status" name="status" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          {RUN_STATUS_OPTIONS.map((o) => {
            // Inline per-status count taken from the already-loaded runs — no
            // extra fetch. "All statuses" sums the per-status counts so the
            // numbers stay consistent with the rest of the dropdown.
            const allCount = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
            const count = o.value === "" ? allCount : statusCounts[o.value] || 0;
            return <option key={o.value} value={o.value}>{o.label} ({count})</option>;
          })}
        </select>
        <select id="runs-filter-range" name="range" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Filter by time range">
          {TIME_RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select id="runs-filter-order" name="order" value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Sort order">
          <option value="desc">Ended newest first</option>
          <option value="asc">Ended oldest first</option>
        </select>
        {workflowOptions.length ? (() => {
          // Collapse the per-workflow checkbox list into a native <details>
          // popover so the toolbar stays one row at common desktop widths even
          // on hubs with dozens of workflows. Native <details> preserves
          // keyboard tab order (summary → checkboxes) and screen-reader
          // announcement without any custom focus management.
          const usingDefault = sameSet(workflows, defaultWorkflows);
          const badge = usingDefault ? "All" : String(workflows.length);
          const badgeTitle = usingDefault
            ? "All non-internal workflows are selected"
            : `${workflows.length} workflow${workflows.length === 1 ? "" : "s"} selected`;
          return (
            <details
              className="runs-workflow-filter"
              open={workflowPanelOpen}
              onToggle={(e) => setWorkflowPanelOpen(e.currentTarget.open)}
            >
              <summary className="runs-workflow-filter-summary" aria-label={`Workflows filter — ${badgeTitle}`}>
                <span>Workflows</span>
                <span className="runs-workflow-filter-badge" data-default={usingDefault ? "true" : "false"} title={badgeTitle}>{badge}</span>
              </summary>
              <div className="runs-workflow-filter-list" role="group" aria-label="Filter by workflow">
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
            </details>
          );
        })() : null}
        <button type="submit" className="button">Apply</button>
        {/* The dedicated Clear button was removed — active filters can be
            reset one at a time via the per-chip × below, which keeps the bar
            compact and matches how operators actually iterate on filters. */}
        <div className="runs-filter-chips" aria-label="Active filters and view options">
          {/* Persistent toggle so operators always see whether support-agent runs are
              currently hidden and can flip the chip without opening a menu. */}
          <button
            type="button"
            className={`runs-filter-chip runs-internal-toggle${showInternal ? " on" : ""}`}
            data-internal-toggle={showInternal ? "on" : "off"}
            aria-pressed={showInternal}
            title={showInternal
              ? "Support-agent and reauth runs are visible. Click to hide them."
              : "Support-agent and reauth runs are hidden. Click to show them."}
            onClick={() => onToggleInternal(!showInternal)}
          >
            {showInternal
              ? "Showing support runs"
              : `Support runs hidden${internalHiddenCount ? ` (${internalHiddenCount})` : ""}`}
          </button>
          {activeChips.map((c) => (
            <span className="runs-filter-chip" data-filter-chip={c.kind} key={c.kind}>
              {c.label}{" "}
              <button type="button" aria-label={`Clear ${c.kind} filter`} data-clear-filter={c.kind} onClick={() => apply(c.kind === "workflows" ? { workflows: defaultWorkflows } : { [c.kind]: c.kind === "order" ? "desc" : "" })}>×</button>
            </span>
          ))}
        </div>
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
  const filtersActive = Boolean(filters.q || filters.status || filters.range || filters.order === "asc" || filters.cursor || Array.isArray(filters.workflows));
  const now = useNow(1000, true);
  const [draftTick, setDraftTick] = useState(0);
  // Per-origin via the browser's natural localStorage scoping. Default off so the
  // operator never sees support-agent noise unless they ask for it.
  const [showInternal, setShowInternal] = useLocalStorage(SHOW_INTERNAL_STORAGE_KEY, false);

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
      p.set("limit", "200");
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

  // Hide internal workflows by default. When filters are active the user has
  // either explicitly picked workflows (`filters.workflows`) — in which case
  // the API already honors that exact list — or filtered on other dimensions,
  // and we still suppress internal runs unless the toggle says otherwise.
  const baseRuns = filtersActive ? runs : topLevelRuns(runs);
  const explicitWorkflowsIncludeInternal = Array.isArray(filters.workflows)
    && filters.workflows.some((slug) => DEFAULT_HIDDEN_WORKFLOWS.includes(slug));
  const shouldShowInternal = showInternal || explicitWorkflowsIncludeInternal;
  const internalHiddenCount = shouldShowInternal ? 0 : baseRuns.filter(isInternalRun).length;
  const visibleRuns = shouldShowInternal ? baseRuns : baseRuns.filter((r) => !isInternalRun(r));
  const hiddenSupervised = filtersActive ? [] : supervisedChildRuns(runs);
  // Single chronological list — active + historical share row chrome.
  const allGroups = groupRunsByEndedDate(visibleRuns, now, filters.order);
  // Counts per status from the already-loaded runs — reactive to filter/refetch
  // without a separate API call. Drives the inline counts in the Status filter.
  const statusCounts = visibleRuns.reduce((acc, run) => {
    const key = run?.status || "";
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const artifactsByRun = new Map();
  for (const a of artifactsQ.data?.artifacts || []) {
    if (!artifactsByRun.has(a.runId)) artifactsByRun.set(a.runId, []);
    artifactsByRun.get(a.runId).push(a);
  }

  const gettingStarted = !filtersActive && visibleRuns.length === 0;

  return (
    <>
      <RerunDraftBanner draft={draft} onDiscard={() => setDraftTick((n) => n + 1)} />
      <HomeFilterBar
        filters={filters}
        capabilities={capabilities}
        matchingCount={totalMatching}
        showInternal={shouldShowInternal}
        onToggleInternal={setShowInternal}
        internalHiddenCount={internalHiddenCount}
        statusCounts={statusCounts}
      />
      {gettingStarted ? (
        <div className="empty empty-runs" role="region" aria-label="No runs yet">
          <p className="empty-runs-headline"><strong>No runs to show</strong></p>
          <p className="muted">
            Workflows you trigger will appear here with logs, artifacts, and re-run controls.
            {internalHiddenCount ? " Support-agent runs are hidden — toggle the chip above to reveal them." : ""}
          </p>
          <div className="empty-runs-actions">
            {/* Primary CTA points at the workflow picker — the one click that
                takes an empty hub to its first triggered run. Quickstart docs
                stay as the secondary affordance. */}
            <button type="button" className="button primary" onClick={() => navigate("#workflows")}>Pick a workflow</button>
            <a className="button" href="/docs#quickstart">Open quickstart</a>
          </div>
        </div>
      ) : (
        <>
          {hiddenSupervised.length ? (
            <p className="supervised-child-summary muted">
              {hiddenSupervised.length} supervised child attempt{hiddenSupervised.length === 1 ? "" : "s"} hidden from this top-level view. Open the parent run to inspect wrapper retries and repair lineage.
            </p>
          ) : null}
          {filtersActive && !visibleRuns.length ? (
            <p className="muted">No runs match the current filters. <a href="#runs">Clear filters</a> to see everything.</p>
          ) : (
            <RunHistoryGroups groups={allGroups} artifactsByRun={artifactsByRun} now={now} />
          )}
          {filtersActive && (filters.cursor || nextCursor) ? (
            <nav className="runs-pagination" aria-label="Run history pagination">
              <p className="muted">{`Showing ${runs.length} of ${totalMatching} matching run${totalMatching === 1 ? "" : "s"}`}</p>
              <div className="toolbar-actions">
                {filters.cursor ? <a className="button" href={`#runs?${filtersToQuery({ ...filters, cursor: "" })}`}>First page</a> : null}
                {nextCursor ? <a className="button primary" href={`#runs?${filtersToQuery({ ...filters, cursor: nextCursor })}`}>Next page →</a> : null}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </>
  );
}
