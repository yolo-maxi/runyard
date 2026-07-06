import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderData,
  renderMenu,
  renderNegotiation,
  renderRunCreated
} from "../src/cliPresentation.js";

describe("CLI presentation helpers", () => {
  it("renders data as JSON or tabular list rows", () => {
    assert.deepEqual(renderData({ ok: true }, { json: true }), ["{\n  \"ok\": true\n}"]);
    assert.deepEqual(renderData([{ slug: "hello", name: "Hello", description: "Greets" }]), ["hello\tHello\tGreets"]);
    assert.deepEqual(renderData([{ id: "run_1", status: "queued", currentStep: "waiting" }]), ["run_1\tqueued\twaiting"]);
  });

  it("renders compact and full menu views", () => {
    const capabilities = Array.from({ length: 6 }, (_, i) => ({ slug: `cap-${i + 1}`, name: `Capability ${i + 1}` }));
    const compact = renderMenu({ capabilities });
    assert.equal(compact[0], "Try: runyard run hello");
    assert.ok(compact.includes("  …1 more — run `runyard menu --all` for the full catalog"));
    const guided = renderMenu({
      capabilities,
      runInputGuidance: {
        title: "For agent-created runs, include input.title."
      }
    });
    assert.ok(guided.includes("Run input: For agent-created runs, include input.title."));
    assert.equal(renderMenu({ capabilities }, { all: true }).some((line) => line.includes("more")), false);
  });

  it("renders negotiation reports with questions, blockers, warnings, and the saved draft", () => {
    assert.deepEqual(renderNegotiation({
      negotiation: {
        status: "needs_input",
        capability: "research",
        questions: [{ field: "prompt", question: "The research question or topic.", expected: "string" }],
        blockers: [{ code: "no_matching_runner", message: "no registered runner matches" }],
        warnings: [{ code: "title_missing", message: "input.title is recommended" }],
        suggestedDefaults: { title: "Research run" },
        nextAction: "Answer questions[]."
      },
      draft: { id: "draft_1" }
    }), [
      "Preflight: needs_input (research)",
      "  needs input: prompt — The research question or topic. [string]",
      "  blocked: no_matching_runner — no registered runner matches",
      "  warning: title_missing — input.title is recommended",
      "  suggested title: Research run",
      "Draft saved: draft_1 (PATCH /api/run-drafts/draft_1, then POST /api/run-drafts/draft_1/submit)",
      "Next: Answer questions[]."
    ]);
  });

  it("renders run-created next steps and improve repo selector", () => {
    assert.deepEqual(renderRunCreated({
      run: {
        id: "run_1",
        capabilitySlug: "improve",
        capabilityName: "Improve",
        execution: { mode: "remote", runnerLocation: "vps" },
        input: { repo: "runyard" }
      }
    }), [
      "Run run_1 queued for Improve.",
      "Execution: remote (vps)",
      "Hub status: runyard run-status run_1",
      "Hub logs: runyard logs run_1",
      "Hub artifacts and outputs: runyard artifacts run_1",
      "Edited repo requested on runner: runyard"
    ]);
  });
});
