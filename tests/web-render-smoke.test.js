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
            code: renderToStaticMarkup(<CodeBlock code={"const answer = 42;"} language="js" />)
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
  });
});
