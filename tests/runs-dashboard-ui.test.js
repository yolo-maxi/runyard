import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanFailureText } from "../web/lib/runHelpers.js";

// Pins the Runs-dashboard behaviour (incident card, plain-English failure
// summary, single mobile nav, compact chrome, safe-area FAB) for the React +
// TanStack frontend. UI structure is asserted on the web/ React source; the
// failure cleaner is imported and exercised for real; CSS rules are asserted on
// the (unchanged) styles.css.
const root = process.cwd();
const runHelpers = readFileSync(path.join(root, "web", "lib", "runHelpers.js"), "utf8");
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
    assert.match(home, /function HomeFilterBar\(\{ filters, capabilities = \[\], matchingCount = 0 \}\)/);
    assert.match(home, /className="runs-filter-panel"/);
    assert.match(home, /id="runs-filter-q"/);
    assert.match(home, /id="runs-filter-status"/);
    assert.match(home, /id="runs-filter-range"/);
    assert.match(home, /id="runs-filter-order"/);
    assert.match(home, /Ended newest first/);
    assert.match(home, /Ended oldest first/);
    assert.match(home, /id="runs-filter-clear"/);
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
    assert.match(css, /\.runs-filter-bar,\s*\n\s*\.runs-filter-bar label,\s*\n\s*\.runs-filter-bar input\[type="search"\]/);
  });

  it("renders completed and matching runs with the compact history row variant while preserving active cards", () => {
    assert.match(runCard, /variant = "card"/);
    assert.match(runCard, /className=\{`run-history-row \$\{run\.status\}`\}/);
    assert.match(runCard, /deepLinks\.run\(run\.id\)/);
    assert.match(runCard, /deepLinks\.workflow\(slug\)/);
    assert.match(runCard, /deepLinks\.runLogs\(run\.id\)/);
    assert.match(runCard, /deepLinks\.runArtifacts\(run\.id\)/);
    assert.match(runCard, /rerunRun\(run\.id\)/);
    assert.match(runCard, /editRerunById\(run\.id\)/);
    assert.match(runCard, /ShareButton hash=\{deepLinks\.run\(run\.id\)\}/);
    assert.match(home, /className="run-grid live in-flight"/);
    assert.match(home, /variant=\{isActiveRun\(run\) \? "card" : "row"\}/);
    assert.match(home, /RunHistoryGroups/);
    assert.match(css, /\.run-history-list/);
    assert.match(css, /\.run-history-row\s*\{[^}]*grid-template-columns/s);
    assert.match(css, /@media \(max-width:\s*640px\)\s*\{[^}]*\.run-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.match(css, /\.run-history-actions \.share-link,[\s\S]*min-height:\s*44px/);
  });

  it("sorts run history by workflow ended date and renders chat-style date separators", () => {
    assert.match(home, /function runEndedAt\(run\)/);
    assert.match(home, /return run\?\.completedAt \|\| run\?\.updatedAt \|\| run\?\.createdAt \|\| ""/);
    assert.match(home, /function compareRunsChronologically\(a, b, order = "desc"\)/);
    assert.match(home, /function groupRunsByEndedDate\(runs, nowMs, order = "desc"\)/);
    assert.match(home, /dayLabel\(key, nowMs\)/);
    assert.match(home, /Today/);
    assert.match(home, /Yesterday/);
    assert.match(home, /className="run-history-day-separator"/);
    assert.match(css, /\.run-history-day-separator/);
    assert.match(css, /\.run-history-day-separator::before,\s*\n\.run-history-day-separator::after/);
    assert.match(css, /\.run-history-day-separator span/);
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
    assert.match(css, /\.run-outcome-summary/);
    assert.match(runDetail, /ShareButton hash=\{deepLinks\.runLogs\(run\.id\)\}/);
    assert.match(runDetail, /ShareButton hash=\{deepLinks\.runArtifacts\(run\.id\)\}/);
    assert.match(css, /\.run-section-summary\s*\{[^}]*min-height:\s*44px/s);
  });
});
