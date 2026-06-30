import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failureAlertLevel,
  maybeRecordFailureClassAlert
} from "../src/failureAlerts.js";

function deps({ count = 3, latest = null, nowMs = Date.parse("2026-06-30T12:00:00.000Z") } = {}) {
  const recorded = [];
  return {
    recorded,
    countRuns: (query) => {
      recorded.query = query;
      return count;
    },
    latestAlert: () => latest,
    recordAlert: (alert) => recorded.push(alert),
    nowMs
  };
}

describe("failure alerts", () => {
  it("skips default failed status and below-threshold statuses", () => {
    const skippedDefault = deps();
    assert.equal(maybeRecordFailureClassAlert("failed", skippedDefault), false);
    assert.equal(skippedDefault.recorded.length, 0);

    const belowThreshold = deps({ count: 2 });
    assert.equal(maybeRecordFailureClassAlert("infra_unavailable", belowThreshold), false);
    assert.equal(belowThreshold.recorded.length, 0);
  });

  it("records warning-level alerts for high-signal failure classes", () => {
    const context = deps({ count: 4 });
    assert.equal(maybeRecordFailureClassAlert("provider_limited", context), true);

    assert.equal(context.recorded[0].kind, "failure:provider_limited");
    assert.equal(context.recorded[0].level, "warning");
    assert.deepEqual(context.recorded[0].data, { status: "provider_limited", count: 4, windowMinutes: 60 });
  });

  it("respects one-hour alert cooldowns", () => {
    const context = deps({
      latest: { createdAt: "2026-06-30T11:30:00.000Z" }
    });

    assert.equal(maybeRecordFailureClassAlert("infra_unavailable", context), false);
    assert.equal(context.recorded.length, 0);
  });

  it("uses info level for other non-default statuses", () => {
    assert.equal(failureAlertLevel("cancelled"), "info");
    assert.equal(failureAlertLevel("infra_unavailable"), "warning");
  });
});
