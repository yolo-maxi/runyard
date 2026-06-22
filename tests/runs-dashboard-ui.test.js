import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the mobile Runs-dashboard fixes (incident card, plain-English failure
// summary, single mobile nav, compact chrome, safe-area FAB). These are
// content assertions on the shipped static assets — the same style the rest of
// the suite uses to guard browser-only code that has no server entry point.
const root = process.cwd();
const appJs = readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");
const indexHtml = readFileSync(path.join(root, "public", "index.html"), "utf8");

describe("Runs dashboard: incident card & plain-English failure summary", () => {
  it("ships the incident card + failure summarizer helpers", () => {
    assert.match(appJs, /function summarizeFailure/);
    assert.match(appJs, /function cleanFailureText/);
    assert.match(appJs, /function incidentCard/);
    // The recommended action for "what happened?" is the loud primary.
    assert.match(appJs, /Inspect failure/);
    assert.match(appJs, /Re-run with same input/);
    // Raw identifiers live behind a copyable disclosure, not on the card lead.
    assert.match(appJs, /incident-tech/);
    assert.match(appJs, /class="incident-copy"/);
  });

  it("strips internal ids / error-class prefixes from the failure sentence", () => {
    // Reconstruct the cleaner from source so the test exercises the real regex
    // set without needing a browser. Keep in sync with cleanFailureText().
    const body = appJs.slice(appJs.indexOf("function cleanFailureText"));
    const fnSrc = body.slice(0, body.indexOf("\n}\n") + 2);
    // eslint-disable-next-line no-new-func
    const cleanFailureText = new Function(`${fnSrc}; return cleanFailureText;`)();
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
    const bar = appJs.slice(appJs.indexOf("function primaryActionBar"), appJs.indexOf("function cleanFailureText"));
    assert.match(bar, /No active runners/);
    assert.match(bar, /View runner health/);
    // The offline branch must not push "Trigger run" as the action.
    const offlineBranch = bar.slice(bar.indexOf("No active runners"));
    assert.ok(!/Trigger run/.test(offlineBranch), "offline state should not recommend Trigger run");
  });
});

describe("Runs dashboard: mobile navigation & chrome", () => {
  it("uses a single mobile nav — the later 900px block no longer re-displays the sidebar", () => {
    // The duplicate Runs/Workflows/Agents row came from a second @media block
    // re-setting `.sidebar { display: flex }`. Guard against its return.
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
    assert.match(indexHtml, /data-badge="runs"/);
    assert.match(appJs, /failed run.*in the last 24h/);
  });
});
