import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderData,
  renderMenu,
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
    assert.equal(renderMenu({ capabilities }, { all: true }).some((line) => line.includes("more")), false);
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
