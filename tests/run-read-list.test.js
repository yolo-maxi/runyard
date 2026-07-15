import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runListFilterResponse,
  runListPage,
  runListQuery
} from "../src/runReadList.js";

describe("run read list helpers", () => {
  it("normalizes list query filters including empty workflow selections", () => {
    assert.deepEqual(runListQuery({ workflows: "", limit: "900" }, ["support-agent"]), {
      status: "",
      limit: 500,
      capability: "",
      workflowSlugs: [],
      capabilitySlugs: ["__runyard-no-workflow__"],
      includeInternal: false,
      explicitEmptyWorkflowFilter: true,
      q: "",
      since: "",
      until: "",
      cursor: "",
      workItemId: "",
      filtered: true
    });

    const query = runListQuery({ capabilities: "alpha,support-agent", capabilitySlug: "beta" }, ["support-agent"]);
    assert.deepEqual(query.workflowSlugs, ["alpha", "support-agent", "beta"]);
    assert.equal(query.includeInternal, true);
  });

  it("falls back to the default run list limit when query input is malformed", () => {
    assert.equal(runListQuery({ limit: "bad" }).limit, 100);
    assert.equal(runListQuery({ limit: "-1" }).limit, 100);
  });

  it("pages filtered run lists with one-row overfetch", () => {
    const calls = { countRuns: [], listRuns: [] };
    const query = runListQuery({ q: "deploy", workflows: "alpha", limit: "2" });
    const page = runListPage({
      query,
      countRuns: (filters) => {
        calls.countRuns.push(filters);
        return 3;
      },
      listRuns: (filters) => {
        calls.listRuns.push(filters);
        return [
          { id: "run_1", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "run_2", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "run_3", createdAt: "2026-01-03T00:00:00.000Z" }
        ];
      }
    });

    assert.equal(calls.listRuns[0].limit, 3);
    assert.deepEqual(calls.countRuns[0].capabilitySlugs, ["alpha"]);
    assert.equal(page.rows.length, 2);
    assert.equal(page.total, 3);
    assert.equal(page.nextCursor, "2026-01-02T00:00:00.000Z");
    assert.deepEqual(runListFilterResponse(query).workflows, ["alpha"]);
  });
});
