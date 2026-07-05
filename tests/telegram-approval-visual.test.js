import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderTelegramApprovalVisual,
  telegramApprovalVisualSummary,
  telegramApprovalVisualSvg
} from "../src/telegramApprovalVisual.js";

describe("telegram approval visual", () => {
  it("summarizes workflow and repo context for the image header", () => {
    assert.deepEqual(
      telegramApprovalVisualSummary({
        approval: { kindLabel: "Workflow gate" },
        workflow: { name: "Research plan implement", slug: "research-plan-implement" },
        project: { repo: "/home/xiko/runyard" }
      }),
      {
        workflow: "Research plan implement",
        repo: "runyard",
        kind: "Workflow gate"
      }
    );
  });

  it("skips bare approvals without repo or workflow context", () => {
    assert.equal(telegramApprovalVisualSummary({ approval: { kindLabel: "Approval" } }), null);
  });

  it("escapes SVG text safely", () => {
    const svg = telegramApprovalVisualSvg({
      workflow: "Deploy <prod>",
      repo: "runyard & hooks",
      kind: "Side effect"
    });
    assert.match(svg, /Deploy &lt;prod&gt;/);
    assert.match(svg, /runyard &amp; hooks/);
    assert.doesNotMatch(svg, /Deploy <prod>/);
  });

  it("renders deterministic SVG to a PNG buffer", async () => {
    const png = await renderTelegramApprovalVisual({
      workflow: "Deploy production",
      repo: "runyard",
      kind: "Side effect"
    });
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  });
});
