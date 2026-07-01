import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdminReadHandlers } from "../src/adminReadRoutes.js";
import { boundedLimit } from "../src/httpQuery.js";
import { mockResponse as response } from "./response.js";

function req(query = {}) {
  return { query };
}

describe("admin read route helpers", () => {
  it("bounds numeric limits with defaults", () => {
    assert.equal(boundedLimit("10", 50, 500), 10);
    assert.equal(boundedLimit("999", 50, 500), 500);
    assert.equal(boundedLimit("bad", 50, 500), 50);
    assert.equal(boundedLimit("-1", 50, 500), 50);
  });

  it("lists audit rows with normalized limit", () => {
    const calls = [];
    const handlers = createAdminReadHandlers({
      listAudit: (options) => {
        calls.push(options);
        return [{ id: "audit_1" }];
      },
      listAlerts: () => []
    });
    const res = response();

    handlers.listAudit(req({ limit: "900" }), res);

    assert.deepEqual(calls[0], { limit: 500 });
    assert.deepEqual(res.body, { audit: [{ id: "audit_1" }] });
  });

  it("lists alerts with kind and normalized limit", () => {
    const calls = [];
    const handlers = createAdminReadHandlers({
      listAudit: () => [],
      listAlerts: (options) => {
        calls.push(options);
        return [{ id: "alert_1" }];
      }
    });
    const res = response();

    handlers.listAlerts(req({ kind: "update", limit: "bad" }), res);

    assert.deepEqual(calls[0], { kind: "update", limit: 50 });
    assert.deepEqual(res.body, { alerts: [{ id: "alert_1" }] });
  });
});
