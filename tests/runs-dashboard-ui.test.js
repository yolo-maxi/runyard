import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanFailureText } from "../web/lib/runHelpers.js";
import {
  groupRunsByEndedDate,
  compareRunsChronologically,
  runEndedAt
} from "../web/lib/runGrouping.js";

// Pins the Runs-dashboard behaviour (incident card, plain-English failure
// summary, single mobile nav, compact chrome, safe-area FAB) for the React +
// TanStack frontend. UI structure is asserted on the web/ React source; the
// failure cleaner is imported and exercised for real; CSS rules are asserted on
// the (unchanged) styles.css.
const root = process.cwd();
const runHelpers = readFileSync(path.join(root, "web", "lib", "runHelpers.js"), "utf8");
const runGrouping = readFileSync(path.join(root, "web", "lib", "runGrouping.js"), "utf8");
const homeChrome = readFileSync(path.join(root, "web", "components", "HomeChrome.jsx"), "utf8");
const home = readFileSync(path.join(root, "web", "views", "Home.jsx"), "utf8");
const runCard = readFileSync(path.join(root, "web", "components", "RunCard.jsx"), "utf8");
const runDetail = readFileSync(path.join(root, "web", "views", "RunDetail.jsx"), "utf8");
const runDetailParts = readFileSync(path.join(root, "web", "components", "RunDetailParts.jsx"), "utf8");
const shell = readFileSync(path.join(root, "web", "app", "Shell.jsx"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");

describe("Runs dashboard: incident card & plain-English failure summary", () => {
  it("ships the incident card + failure summarizer helpers", () => {
    assert.match(runHelpers, /export function summarizeFailure/);
    assert.match(runHelpers, /export function cleanFailureText/);
    assert.match(homeChrome, /export function IncidentCard/);
    // The recommended action for "what happened?" is the loud primary.
    assert.match(homeChrome, /Inspect failure/);
    assert.match(homeChrome, /Re-run with same input/);
    // Raw identifiers live behind a copyable disclosure, not on the card lead.
    assert.match(homeChrome, /incident-tech/);
    assert.match(homeChrome, /incident-copy/);
  });

  it("strips internal ids / error-class prefixes from the failure sentence", () => {
    // Exercises the real cleaner imported from the React source.
    const raw =
      "SmithersError: NodeFailed node_9f2a1c at agent 3b7c4d2e-1a2b-4c3d-9e8f-0a1b2c3d4e5f: " +
      "TypeError: Cannot read properties of undefined (reading 'spec') during step 'generate-spec' (run run_deadbeef0011)";
    const out = cleanFailureText(raw);
    assert.ok(!/SmithersError|NodeFailed/.test(out), `class prefix not stripped: ${out}`);
    assert.ok(!/node_9f2a1c|run_deadbeef0011/.test(out), `ids not stripped: ${out}`);
    assert.ok(!/3b7c4d2e-1a2b/.test(out), `uuid not stripped: ${out}`);
    // Useful signal is retained.
    assert.match(out, /TypeError/);
    assert.match(out, /generate-spec/);
  });

  it("recommends runner health (not 'Trigger run') when all runners are offline", () => {
    const bar = homeChrome.slice(homeChrome.indexOf("export function PrimaryActionBar"), homeChrome.indexOf("IncidentCopy"));
    assert.match(bar, /No active runners/);
    assert.match(bar, /View runner health/);
    // The offline branch must not push "Trigger run" as the action.
    const offlineBranch = bar.slice(bar.indexOf("No active runners"));
    assert.ok(!/Trigger run/.test(offlineBranch), "offline state should not recommend Trigger run");
  });
});

describe("Runs dashboard: mobile navigation & chrome", () => {
  it("uses a single mobile nav — the later 900px block no longer re-displays the sidebar", () => {
    assert.ok(!/\.sidebar\s*\{\s*display:\s*flex/.test(css), "sidebar must not be re-displayed as a flex bar on mobile");
    assert.match(css, /max-width:\s*900px/);
  });

  it("dials environment chrome down and hides the deep-link hint on mobile", () => {
    assert.match(css, /\.brand-pill\s*\{\s*display:\s*none/);
    assert.match(css, /\.env-chip-host\s*\{\s*display:\s*none/);
    assert.match(css, /\.deep-link-hint\s*\{\s*display:\s*none/);
  });

  it("respects safe-area insets on the topbar and the support FAB", () => {
    assert.match(css, /env\(safe-area-inset-top\)/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
  });

  it("labels the Runs failed-count badge so it can't be confused with total runs", () => {
    // The reactive nav badge lives in the React Shell now (derived from the
    // runs collection, replacing the legacy 30s poll), and the 24h failure
    // window is surfaced in the incident card impact line.
    assert.match(shell, /data-badge=\{kind\}/);
    assert.match(shell, /kind="runs"/);
    assert.match(homeChrome, /in the last 24h/);
  });
});

describe("Runs page: filter toolbar, history rows, and detail order", () => {
  it("keeps runs search and filters visible without a disclosure", () => {
    assert.match(home, /function HomeFilterBar\(\{ filters, capabilities = \[\]/);
    assert.match(home, /className="runs-filter-panel"/);
    assert.match(home, /id="runs-filter-q"/);
    assert.match(home, /id="runs-filter-status"/);
    assert.match(home, /id="runs-filter-range"/);
    assert.match(home, /id="runs-filter-order"/);
    assert.match(home, /Ended newest first/);
    assert.match(home, /Ended oldest first/);
    // The rightmost Clear button was removed — active filters get cleared
    // one at a time via the per-chip × buttons below the bar.
    assert.ok(!/id="runs-filter-clear"/.test(home), "the dedicated Clear button should be gone");
    // Visible field labels ("Search", "Status", "Time", "Order") were dropped —
    // the placeholder / selected option carries the meaning, and each control
    // exposes an aria-label so screen readers still announce it.
    assert.ok(!/<span className="muted">Search<\/span>/.test(home), "Search label should be dropped");
    assert.ok(!/<span className="muted">Status<\/span>/.test(home), "Status label should be dropped");
    assert.ok(!/<span className="muted">Time<\/span>/.test(home), "Time label should be dropped");
    assert.ok(!/<span className="muted">Order<\/span>/.test(home), "Order label should be dropped");
    assert.match(home, /aria-label="Search runs"/);
    assert.match(home, /aria-label="Filter by status"/);
    assert.match(home, /aria-label="Filter by time range"/);
    assert.match(home, /aria-label="Sort order"/);
    assert.match(home, /DEFAULT_HIDDEN_WORKFLOWS = \["runyard-support-agent", "reauth-cli"\]/);
    assert.match(home, /className="runs-workflow-filter"/);
    assert.match(home, /type="checkbox"/);
    assert.match(home, /Array\.isArray\(filters\.workflows\)/);
    assert.match(home, /p\.set\("workflows", filters\.workflows\.join\(","\)\)/);
    assert.match(home, /filtersToQuery\(merged\)/);
    assert.ok(!/runs-filter-details/.test(home), "filter controls should not hide behind details");
    assert.match(css, /\.runs-filter-panel/);
    assert.match(css, /\.runs-workflow-filter-list/);
    assert.match(css, /\.runs-filter-bar input\[type="search"\]\s*\{[^}]*min-height:\s*44px/s);
    assert.match(css, /@media \(max-width:\s*640px\)\s*\{[^}]*\.runs-filter-panel/s);
    // Mobile stretching is scoped: the whole form becomes a compact grid, while
    // individual buttons do not all inherit width:100%.
    assert.match(css, /\.runs-filter-bar\s*\{\s*display:\s*grid;/);
    assert.match(css, /\.runs-filter-bar input\[type="search"\]\s*\{[^}]*grid-column:\s*1 \/ -1/s);
    assert.ok(!/\.runs-filter-bar button\s*\{\s*width:\s*100%/s.test(css), "buttons should not globally stretch full-width");
  });

  it("hides support-agent runs by default and reveals them only via workflow filters", () => {
    assert.match(home, /DEFAULT_HIDDEN_WORKFLOWS = \["runyard-support-agent", "reauth-cli"\]/);
    assert.match(home, /defaultWorkflowSlugs\(capabilities\)/);
    assert.match(home, /workflowOptions\.map\(\(cap\)/);
    assert.match(home, /filters\.workflows\.join\(","\)/);
    assert.ok(!/SHOW_INTERNAL_STORAGE_KEY/.test(home), "persistent support-run toggle should be removed");
    assert.ok(!/runs-internal-toggle/.test(home), "support-run toggle chip should be removed");
    assert.ok(!/Support runs hidden/.test(home), "hidden support copy should be removed");
    assert.ok(!/Showing support runs/.test(home), "showing support copy should be removed");
    assert.ok(!/runs-filter-chip\.runs-internal-toggle/.test(css), "support-run toggle styles should be removed");
  });

  it("renders every run — active and historical — as a unified history row", () => {
    assert.match(runCard, /variant = "card"/);
    // Row variant now accepts active runs too; the className adds " active"
    // (and the row gets a pulse dot) so the status badge stays the only visual
    // differentiator between in-flight and historical rows.
    assert.match(runCard, /if \(variant === "row"\)/);
    assert.match(runCard, /run-history-row \$\{run\.status\}\$\{active \? " active" : ""\}/);
    assert.match(runCard, /run-pulse run-pulse-row/);
    assert.match(runCard, /deepLinks\.run\(run\.id\)/);
    assert.match(runCard, /deepLinks\.workflow\(slug\)/);
    assert.match(runCard, /deepLinks\.runLogs\(run\.id\)/);
    assert.match(runCard, /deepLinks\.runArtifacts\(run\.id\)/);
    assert.match(runCard, /rerunRun\(run\.id\)/);
    assert.match(runCard, /editRerunById\(run\.id\)/);
    assert.match(runCard, /ShareButton hash=\{deepLinks\.run\(run\.id\)\}/);
    // The dedicated in-flight card grid is gone — RunHistoryGroups drives the
    // whole list with variant="row".
    assert.ok(!/run-grid live in-flight/.test(home), "in-flight card grid should be removed");
    assert.match(home, /variant="row"/);
    assert.match(home, /RunHistoryGroups/);
    assert.match(css, /\.run-history-list/);
    assert.match(css, /\.run-history-row\s*\{[^}]*grid-template-columns/s);
    assert.match(css, /\.run-history-row\.active\s*\{/);
    assert.match(css, /@media \(max-width:\s*640px\)\s*\{[^}]*\.run-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.match(css, /\.run-history-actions \.share-link,[\s\S]*min-height:\s*44px/);
  });

  it("strips home-page clutter — stats strip, action bar, and approvals panel — from the runs view", () => {
    // Stats strip, primary-action / incident hero, and pending-approvals list
    // no longer compete with the runs table for vertical space on #runs.
    assert.ok(!/HomeStatStrip/.test(home), "HomeStatStrip must not render on the runs page");
    assert.ok(!/PrimaryActionBar/.test(home), "PrimaryActionBar must not render on the runs page");
    assert.ok(!/IncidentCard/.test(home), "IncidentCard must not render on the runs page");
    assert.ok(!/ApprovalList/.test(home), "ApprovalList must not render on the runs page");
    assert.ok(!/Pending approvals/.test(home), "Pending approvals heading must not render on the runs page");
  });

  it("sorts run history by workflow ended date and renders chat-style date separators", () => {
    assert.match(runGrouping, /export function runEndedAt\(run\)/);
    assert.match(runGrouping, /return run\?\.completedAt \|\| run\?\.updatedAt \|\| run\?\.createdAt \|\| ""/);
    assert.match(runGrouping, /export function compareRunsChronologically\(a, b, order = "desc"\)/);
    assert.match(runGrouping, /export function groupRunsByEndedDate\(runs, nowMs, order = "desc"\)/);
    assert.match(runGrouping, /dayLabel\("active", nowMs\)/);
    assert.match(home, /import \{ groupRunsByEndedDate \} from "\.\.\/lib\/runGrouping\.js"/);
    assert.match(home, /groupRunsByEndedDate\(visibleRuns, now, filters\.order\)/);
    assert.match(runGrouping, /Today|dayLabel/);
    assert.match(home, /className="run-history-day-separator"/);
    assert.match(css, /\.run-history-day-separator/);
    assert.match(css, /\.run-history-day-separator::before,\s*\n\.run-history-day-separator::after/);
    assert.match(css, /\.run-history-day-separator span/);
  });

  it("leads with active runs so a completed run from today never sits above a running one", () => {
    // Fran's screenshot: a succeeded run at 15:04 appearing above a running run
    // that started at 14:50. This is the bug — active work must always lead.
    const NOW = Date.parse("2026-07-01T15:10:00Z");
    const runs = [
      // Completed today, 6 minutes ago — has the newest overall timestamp.
      { id: "r-done-today", status: "succeeded", createdAt: "2026-07-01T14:30:00Z",
        startedAt: "2026-07-01T14:31:00Z", completedAt: "2026-07-01T15:04:00Z" },
      // Running, started 20 minutes ago — older timestamp than the completed run.
      { id: "r-running", status: "running", createdAt: "2026-07-01T14:45:00Z",
        startedAt: "2026-07-01T14:50:00Z" },
      // Queued, just now — no startedAt yet.
      { id: "r-queued", status: "queued", createdAt: "2026-07-01T15:09:30Z" },
      // Waiting for approval — also active.
      { id: "r-waiting", status: "waiting_approval", createdAt: "2026-07-01T14:00:00Z",
        startedAt: "2026-07-01T14:05:00Z" },
      // Failed yesterday.
      { id: "r-failed-yday", status: "failed", createdAt: "2026-06-30T10:00:00Z",
        startedAt: "2026-06-30T10:01:00Z", completedAt: "2026-06-30T10:20:00Z" }
    ];
    const groups = groupRunsByEndedDate(runs, NOW, "desc");
    assert.equal(groups[0].key, "active", "the first group must be the In flight group");
    assert.equal(groups[0].label, "In flight");
    const activeIds = groups[0].runs.map((r) => r.id);
    assert.deepEqual(new Set(activeIds), new Set(["r-running", "r-queued", "r-waiting"]));
    // No active run may be grouped under a day heading — a completed run from
    // today must not appear above an in-flight run.
    for (let i = 1; i < groups.length; i += 1) {
      for (const run of groups[i].runs) {
        assert.ok(!["queued", "running", "waiting_approval", "assigned", "pending"].includes(run.status),
          `active run ${run.id} leaked into non-active group ${groups[i].key}`);
      }
    }
    // Today's completed run sits below "In flight", above yesterday's — assert
    // on group index by run id, not on the "Today"/"Yesterday" label so the
    // test survives non-UTC test runners.
    const todayIndex = groups.findIndex((g) => g.runs.some((r) => r.id === "r-done-today"));
    const yesterdayIndex = groups.findIndex((g) => g.runs.some((r) => r.id === "r-failed-yday"));
    assert.ok(todayIndex > 0, "today's completed run must not sit above In flight");
    assert.ok(yesterdayIndex > todayIndex, "yesterday's completed run must sit below today's");
    assert.deepEqual(groups[todayIndex].runs.map((r) => r.id), ["r-done-today"]);
    assert.deepEqual(groups[yesterdayIndex].runs.map((r) => r.id), ["r-failed-yday"]);
  });

  it("keeps active-first even when the operator asks for oldest-ended-first history", () => {
    // The toolbar's ascending sort reorders history buckets only; live work
    // must never migrate below terminal runs.
    const NOW = Date.parse("2026-07-01T12:00:00Z");
    const runs = [
      { id: "old-done", status: "succeeded", createdAt: "2026-06-25T08:00:00Z",
        startedAt: "2026-06-25T08:01:00Z", completedAt: "2026-06-25T08:30:00Z" },
      { id: "recent-done", status: "succeeded", createdAt: "2026-06-30T08:00:00Z",
        startedAt: "2026-06-30T08:01:00Z", completedAt: "2026-06-30T08:30:00Z" },
      { id: "live", status: "running", createdAt: "2026-07-01T11:00:00Z",
        startedAt: "2026-07-01T11:05:00Z" }
    ];
    const asc = groupRunsByEndedDate(runs, NOW, "asc");
    assert.equal(asc[0].key, "active", "even in asc mode, In flight leads");
    assert.deepEqual(asc[0].runs.map((r) => r.id), ["live"]);
    // The two terminal days are ordered oldest→newest below active.
    assert.equal(asc[1].runs[0].id, "old-done");
    assert.equal(asc[2].runs[0].id, "recent-done");
  });

  it("orders multiple active runs by most recently started first", () => {
    const NOW = Date.parse("2026-07-01T15:00:00Z");
    const runs = [
      { id: "started-earlier", status: "running", createdAt: "2026-07-01T13:00:00Z",
        startedAt: "2026-07-01T13:10:00Z" },
      { id: "started-latest", status: "running", createdAt: "2026-07-01T14:50:00Z",
        startedAt: "2026-07-01T14:55:00Z" },
      { id: "started-middle", status: "running", createdAt: "2026-07-01T14:00:00Z",
        startedAt: "2026-07-01T14:10:00Z" }
    ];
    const groups = groupRunsByEndedDate(runs, NOW, "desc");
    assert.equal(groups.length, 1, "only the In flight group when nothing terminal");
    assert.deepEqual(
      groups[0].runs.map((r) => r.id),
      ["started-latest", "started-middle", "started-earlier"]
    );
  });

  it("runEndedAt prefers completedAt for terminal runs and startedAt for active runs", () => {
    assert.equal(
      runEndedAt({ status: "succeeded", completedAt: "2026-07-01T10:00:00Z",
        startedAt: "2026-07-01T09:00:00Z", createdAt: "2026-07-01T08:00:00Z" }),
      "2026-07-01T10:00:00Z"
    );
    assert.equal(
      runEndedAt({ status: "running", startedAt: "2026-07-01T09:00:00Z",
        createdAt: "2026-07-01T08:00:00Z" }),
      "2026-07-01T09:00:00Z"
    );
    // No status → treated as terminal; falls back to updatedAt then createdAt.
    assert.equal(runEndedAt({ updatedAt: "2026-07-01T07:00:00Z" }), "2026-07-01T07:00:00Z");
    assert.equal(runEndedAt({}), "");
    // compareRunsChronologically stays a stable tiebreaker for identical timestamps.
    const a = { id: "aaa", status: "succeeded", completedAt: "2026-07-01T10:00:00Z" };
    const b = { id: "bbb", status: "succeeded", completedAt: "2026-07-01T10:00:00Z" };
    assert.ok(compareRunsChronologically(a, b, "desc") < 0);
    assert.ok(compareRunsChronologically(b, a, "desc") > 0);
  });

  it("orders terminal run detail around outcome before console history", () => {
    const firstConsole = runDetail.indexOf("{active ? (");
    const io = runDetail.indexOf('name="io"');
    const log = runDetail.indexOf('name="log"');
    const artifacts = runDetail.indexOf('name="artifacts"');
    const history = runDetail.indexOf('title="Console history"');
    const context = runDetail.indexOf('name="context"');
    assert.ok(firstConsole > -1 && firstConsole < io, "active live console should remain first");
    assert.ok(io < log, "Inputs & outputs should precede Run log");
    assert.ok(log < artifacts, "Run log should precede Artifacts");
    assert.ok(artifacts < history, "Artifacts should precede terminal Console history");
    assert.ok(history < context, "Console history should precede Run context");
    assert.match(runDetail, /focus === "logs"/);
    assert.match(runDetail, /focus === "artifacts"/);
    assert.match(runDetail, /<RunOutcomeSummary summary=\{run\.outcomeSummary\} \/>/);
    assert.match(runDetailParts, /function RunOutcomeSummary/);
    assert.match(runDetailParts, /Changed files/);
    // GitHub-style +added/-removed churn + one-sentence digest surface on
    // the run detail so operators see diff size + a plain-English readout
    // without having to open the run log.
    assert.match(runDetailParts, /Code churn/);
    assert.match(runDetailParts, /<CodeChurn/);
    assert.match(runDetailParts, /run-outcome-digest/);
    assert.match(runCard, /runChurn/);
    assert.match(runCard, /runDigest/);
    // The "N changed files" chip surfaces the same signal as run detail's
    // "Changed files" tile so the runs history no longer implies "nothing
    // changed" when the outcome summary carries the real count.
    assert.match(runCard, /runChangedFiles/);
    assert.match(runCard, /chip-files/);
    assert.match(runCard, /run-card-digest/);
    assert.match(runCard, /run-history-digest/);
    assert.match(css, /\.run-outcome-summary/);
    assert.match(css, /\.code-churn-add/);
    assert.match(css, /\.code-churn-del/);
    assert.match(css, /\.run-outcome-digest/);
    assert.match(css, /\.run-card-digest/);
    assert.match(css, /\.run-history-digest/);
    assert.match(css, /\.chip-files/);
    assert.match(runDetail, /ShareButton hash=\{deepLinks\.runLogs\(run\.id\)\}/);
    assert.match(runDetail, /ShareButton hash=\{deepLinks\.runArtifacts\(run\.id\)\}/);
    assert.match(css, /\.run-section-summary\s*\{[^}]*min-height:\s*44px/s);
  });
});
