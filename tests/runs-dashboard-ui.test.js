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
