import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempRoot = path.join(process.cwd(), "test-artifacts");
mkdirSync(tempRoot, { recursive: true });
const temp = mkdtempSync(path.join(tempRoot, "runyard-web-render-"));
const bundlePath = path.join(temp, "render-smoke.mjs");

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

async function loadRenderSmoke() {
  await build({
    stdin: {
      sourcefile: "render-smoke.jsx",
      resolveDir: process.cwd(),
      loader: "jsx",
      contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { ApprovalList } from "./web/components/ApprovalList.jsx";
        import { RunProgressStrip } from "./web/components/RunProgressStrip.jsx";
        import { CodeBlock } from "./web/components/CodeBlock.jsx";
        import { RunCard } from "./web/components/RunCard.jsx";
        import { RunBudgetNotice, RunPauseNotice, RunMetaStrip } from "./web/components/RunDetailParts.jsx";
        import { StatusBadge } from "./web/components/ui.jsx";
        import { WorkCard } from "./web/components/WorkCard.jsx";
        import { WorkFlowStepper } from "./web/components/WorkFlowStepper.jsx";

        export function renderSmoke() {
          const run = {
            id: "run_smoke",
            status: "running",
            currentStep: "building",
            createdAt: "2026-06-26T20:00:00.000Z",
            assignedAt: "2026-06-26T20:00:05.000Z",
            startedAt: "2026-06-26T20:00:10.000Z"
          };
          return {
            approvalsEmpty: renderToStaticMarkup(<ApprovalList approvals={[]} />),
            approvalsCompact: renderToStaticMarkup(<ApprovalList approvals={[{
              id: "appr_smoke",
              status: "pending",
              title: "Approve compact card",
              timeoutAt: "2026-07-05T00:00:00.000Z",
              runId: "run_smoke",
              deepLinkRun: "/app#runs/run_smoke",
              context: {
                approval: { statusLabel: "Pending decision", kindLabel: "Workflow gate" },
                ask: { action: "Release the held run.", reason: "Operator sign-off required." },
                run: { statusLabel: "Waiting for approval" }
              }
            }]} />),
            progress: renderToStaticMarkup(<RunProgressStrip run={run} now={Date.parse("2026-06-26T20:00:40.000Z")} />),
            code: renderToStaticMarkup(<CodeBlock code={"const answer = 42;"} language="js" />),
            meteredCard: renderToStaticMarkup(<RunCard variant="row" now={Date.parse("2026-06-26T21:00:00.000Z")} run={{
              id: "run_metered",
              status: "succeeded",
              capabilitySlug: "research",
              createdAt: "2026-06-26T20:00:00.000Z",
              startedAt: "2026-06-26T20:00:10.000Z",
              completedAt: "2026-06-26T20:05:10.000Z",
              usage: { totalTokens: 12345, costMicros: 420000, calls: 3, byModel: {} }
            }} />),
            budgetMeta: renderToStaticMarkup(<RunMetaStrip run={{
              id: "run_budget",
              status: "budget_exceeded",
              createdAt: "2026-06-26T20:00:00.000Z",
              startedAt: "2026-06-26T20:00:10.000Z",
              completedAt: "2026-06-26T20:05:10.000Z",
              usage: { totalTokens: 120, costMicros: 0, calls: 2, byModel: { m1: { totalTokens: 120, costMicros: 0 } } },
              budget: { maxTokens: 100 }
            }} />),
            budgetNotice: renderToStaticMarkup(<RunBudgetNotice run={{
              id: "run_budget",
              status: "budget_exceeded",
              error: "budget exceeded: 120 tokens used, budget.maxTokens is 100"
            }} />),
            budgetNoticeHidden: renderToStaticMarkup(<div>{RunBudgetNotice({ run: { id: "r", status: "succeeded" } })}</div>),
            pausedBadge: renderToStaticMarkup(<StatusBadge value="paused" />),
            pauseNotice: renderToStaticMarkup(<RunPauseNotice run={{
              id: "run_paused",
              status: "paused",
              pause: {
                reason: "credits_exhausted",
                message: "Provider returned 402: credit balance is too low",
                pausedAt: "2026-07-09T12:00:00.000Z",
                pausedBy: "gateway",
                resumable: true,
                resume: { smithersRunId: "run-1234", strategy: "smithers_resume" },
                requiredAction: { type: "add_credits", label: "Add credits, then resume" }
              }
            }} />),
            pauseNoticeResumeFailed: renderToStaticMarkup(<RunPauseNotice run={{
              id: "run_resume_failed",
              status: "paused",
              pause: {
                reason: "resume_failed",
                message: "Recorded engine checkpoint run-1234 was not found in this runner's local .smithers state",
                pausedAt: "2026-07-15T12:00:00.000Z",
                pausedBy: "runner",
                resumable: true,
                requiredAction: { type: "operator_resume", label: "Resume again to re-run from scratch, or cancel" }
              }
            }} />),
            pauseNoticeHidden: renderToStaticMarkup(<div>{RunPauseNotice({ run: { id: "r", status: "running" } })}</div>),
            workCard: renderToStaticMarkup(<WorkCard now={Date.parse("2026-07-15T12:00:00.000Z")} onMove={() => {}} item={{
              id: "wi_smoke",
              title: "Make pause/resume fully supported",
              status: "blocked",
              type: "feature",
              priority: "high",
              project: "runyard",
              owner: "fran",
              nextAction: "Decide the resume strategy default",
              blockedReason: "Waiting on provider credits",
              updatedAt: "2026-07-15T11:00:00.000Z",
              runs: { total: 3, byStatus: { succeeded: 1, running: 1, paused: 1 }, attention: 1, lastRunAt: "2026-07-15T10:00:00.000Z" }
            }} />),
            workFlow: renderToStaticMarkup(<WorkFlowStepper now={Date.parse("2026-07-15T12:00:00.000Z")} flow={{
              runId: "run_flow",
              status: "running",
              currentStep: "verify",
              name: "idea-to-product",
              source: "workflow-source",
              counts: { done: 1, active: 1, waiting: 1, pending: 1 },
              nodes: [
                { id: "workflow", kind: "entry", label: "idea-to-product", state: "done" },
                { id: "plan", kind: "task", label: "plan", state: "done", startedAt: "2026-07-15T11:00:00.000Z", finishedAt: "2026-07-15T11:05:00.000Z", events: 4, errors: 0 },
                { id: "build", kind: "task", label: "build", state: "active", startedAt: "2026-07-15T11:05:00.000Z", events: 9, errors: 0, lastEventType: "node.started" },
                { id: "gate", kind: "approval", label: "gate", state: "waiting", events: 1, errors: 0 },
                { id: "ship", kind: "deploy", label: "ship", state: "pending", events: 0, errors: 0 }
              ],
              edges: [],
              pendingApprovals: [{ id: "appr_flow", title: "Approve the ship step", kind: "workflow_gate", createdAt: "2026-07-15T11:30:00.000Z" }]
            }} />)
          };
        }
      `
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    packages: "external",
    jsx: "automatic",
    loader: { ".js": "jsx", ".jsx": "jsx" },
    outfile: bundlePath,
    logLevel: "silent"
  });
  return import(pathToFileURL(bundlePath).href);
}

describe("React render smoke", () => {
  it("renders migrated UI components without browser globals", async () => {
    const { renderSmoke } = await loadRenderSmoke();
    const html = renderSmoke();

    assert.match(html.approvalsEmpty, /class="empty"/);
    assert.match(html.approvalsEmpty, /No pending approvals/);
    assert.match(html.approvalsCompact, /approval-card-rows/);
    assert.match(html.approvalsCompact, /<dt>Ask<\/dt>/);
    assert.match(html.approvalsCompact, /<dt>Ignored<\/dt>/);
    assert.match(html.approvalsCompact, /2026-07-05T00:00:00\.000Z → needs human/);

    assert.match(html.progress, /data-run-progress="run_smoke"/);
    assert.match(html.progress, /building/);
    assert.match(html.progress, /phase-active|phase-done/);

    assert.match(html.code, /class="hljs language-javascript"/);
    assert.match(html.code, /answer/);

    // Metered usage renders as a chip on run cards…
    assert.match(html.meteredCard, /chip-usage/);
    assert.match(html.meteredCard, /12k tok/);
    assert.match(html.meteredCard, /\$0\.42/);
    // …and on the run-detail meta strip, alongside the budget ceiling.
    assert.match(html.budgetMeta, /Usage/);
    assert.match(html.budgetMeta, /120 tok/);
    assert.match(html.budgetMeta, /Budget/);
    assert.match(html.budgetMeta, /100 tok/);
    // Budget stops get an explicit, plain-English callout — and nothing
    // renders for runs that were not budget-stopped.
    assert.match(html.budgetNotice, /run-budget-notice/);
    assert.match(html.budgetNotice, /Stopped at budget/);
    assert.match(html.budgetNotice, /budget exceeded: 120 tokens/);
    assert.equal(html.budgetNoticeHidden, "<div></div>");

    // Work board card: chips, run rollup, attention badge, move select.
    assert.match(html.workCard, /data-work-item="wi_smoke"/);
    assert.match(html.workCard, /Make pause\/resume fully supported/);
    assert.match(html.workCard, /work-priority-high/);
    assert.match(html.workCard, /3 runs/);
    assert.match(html.workCard, /1 need attention/);
    assert.match(html.workCard, /Waiting on provider credits/);
    assert.match(html.workCard, /data-move-work-item="wi_smoke"/);
    // Execution-flow stepper: per-step states + pending approval link.
    assert.match(html.workFlow, /data-flow-run="run_flow"/);
    assert.match(html.workFlow, /state-done/);
    assert.match(html.workFlow, /state-active/);
    assert.match(html.workFlow, /state-waiting/);
    assert.match(html.workFlow, /state-pending/);
    assert.match(html.workFlow, /Approve the ship step/);
    assert.doesNotMatch(html.workFlow, /data-flow-node="workflow"/); // entry node skipped

    // Paused runs: amber badge, plain-English pause callout with the reason,
    // required action, checkpoint, and a resume control — and nothing renders
    // for runs that are not paused.
    assert.match(html.pausedBadge, /class="status paused"/);
    assert.match(html.pausedBadge, /Paused/);
    assert.match(html.pauseNotice, /run-pause-notice/);
    assert.match(html.pauseNotice, /Provider credits exhausted/);
    assert.match(html.pauseNotice, /Add credits, then resume/);
    assert.match(html.pauseNotice, /run-1234/);
    assert.match(html.pauseNotice, /Resume run/);
    // A recorded checkpoint also offers the explicit from-scratch fallback
    // (for a stale checkpoint or a retired pinned runner).
    assert.match(html.pauseNotice, /Restart from scratch/);
    // A resume_failed pause says what happened and what to do next — and,
    // having no checkpoint, offers only the plain (from-scratch) resume.
    assert.match(html.pauseNoticeResumeFailed, /Resume failed — checkpoint unavailable/);
    assert.match(html.pauseNoticeResumeFailed, /re-run from scratch, or cancel/);
    assert.match(html.pauseNoticeResumeFailed, /no engine checkpoint was recorded/);
    assert.match(html.pauseNoticeResumeFailed, /Resume run/);
    assert.ok(!html.pauseNoticeResumeFailed.includes("Restart from scratch"));
    assert.equal(html.pauseNoticeHidden, "<div></div>");
  });
});
