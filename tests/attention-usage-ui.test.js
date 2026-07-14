import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// Pins the browser surfaces shipped with the metered/resumable productization
// batch: the needs-attention triage strip on Home, paused/budget chips on run
// lists, the spent-vs-limit budget pairing on run detail, and the token-filled
// connect snippets. Source-level assertions, matching the other *-ui tests.
const root = process.cwd();
const attentionJsx = readFileSync(path.join(root, "web", "components", "AttentionStrip.jsx"), "utf8");
const homeJsx = readFileSync(path.join(root, "web", "views", "Home.jsx"), "utf8");
const runCardJsx = readFileSync(path.join(root, "web", "components", "RunCard.jsx"), "utf8");
const runDetailPartsJsx = readFileSync(path.join(root, "web", "components", "RunDetailParts.jsx"), "utf8");
const connectJsx = readFileSync(path.join(root, "web", "views", "Connect.jsx"), "utf8");
const runHelpersJs = readFileSync(path.join(root, "web", "lib", "runHelpers.js"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");

describe("needs-attention strip", () => {
  it("fetches the attention queue and renders resume/review/inspect actions", () => {
    assert.match(attentionJsx, /\/api\/runs\/attention/);
    assert.match(attentionJsx, /resumeRun\(run\.id\)/);
    assert.match(attentionJsx, /deepLinks\.approvals\(\)/);
    assert.match(attentionJsx, /Stopped at budget/);
    assert.match(attentionJsx, /pauseReasonLabel/);
    // Non-resumable paused runs must not offer a resume button.
    assert.match(attentionJsx, /resumable !== false/);
  });

  it("mounts on Home above the filter bar", () => {
    assert.match(homeJsx, /import { AttentionStrip } from "\.\.\/components\/AttentionStrip\.jsx"/);
    assert.match(homeJsx, /<AttentionStrip \/>[\s\S]*?<HomeFilterBar/);
  });

  it("has styles for the strip and renders nothing when idle", () => {
    assert.match(css, /\.attention-strip \{/);
    assert.match(attentionJsx, /if \(!total\) return null;/);
  });
});

describe("run list chips for paused and budget", () => {
  it("marks paused runs with their pause reason on both card variants", () => {
    const matches = runCardJsx.match(/chip chip-paused/g) || [];
    assert.equal(matches.length, 2, "paused chip on row + card variants");
    assert.match(runCardJsx, /pauseReasonLabel\(run\.pause\?\.reason\)/);
  });

  it("marks near-limit and budget-stopped runs", () => {
    assert.match(runCardJsx, /runBudgetChip\(run\)/);
    assert.match(runCardJsx, /chip-budget-\$\{budgetChip\.tone\}/);
    assert.match(css, /\.chip-budget-warn \{/);
    assert.match(css, /\.chip-budget-stop \{/);
    assert.match(css, /\.chip-paused \{/);
  });

  it("derives the chip from the server-computed budgetStatus", () => {
    assert.match(runHelpersJs, /export function runBudgetChip/);
    assert.match(runHelpersJs, /budgetStatus/);
    assert.match(runHelpersJs, /nearLimit/);
  });

  it("offers budget_exceeded in the status filter", () => {
    assert.match(runHelpersJs, /\{ value: "budget_exceeded", label: "Stopped at budget" \}/);
  });
});

describe("run detail budget legibility", () => {
  it("pairs spent with limit (percent) on the meta strip", () => {
    assert.match(runDetailPartsJsx, /run\.budgetStatus/);
    assert.match(runDetailPartsJsx, /tokensPercentUsed/);
    assert.match(runDetailPartsJsx, /data-near-limit/);
  });

  it("states the numbers in the budget-stop notice", () => {
    assert.match(runDetailPartsJsx, /budgeted tokens/);
    assert.match(runDetailPartsJsx, /Raise the budget and re-run/);
  });
});

describe("connect token snippets", () => {
  it("offers token-filled CLI and curl examples after minting, masked", () => {
    assert.match(connectJsx, /runyard login --url \$\{origin\} --token \$\{issued\.token\}/);
    assert.match(connectJsx, /Bearer \$\{issued\.token\}/);
    // Both ride the masked SecretRow so the token stays out of screenshots.
    assert.match(connectJsx, /SecretRow id="invite-cli"/);
    assert.match(connectJsx, /SecretRow id="invite-curl"/);
  });
});
