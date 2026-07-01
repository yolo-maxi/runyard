import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRateLimiter,
  expressErrorHandler,
  jsonBodyMiddleware,
  securityHeaders
} from "../src/httpMiddleware.js";
import { mockResponse } from "./response.js";

describe("HTTP middleware helpers", () => {
  it("sets app-aware security headers", () => {
    const appRes = mockResponse();
    securityHeaders({ baseUrl: "https://hub.example" })({ path: "/app" }, appRes, () => {});
    assert.equal(appRes.headers["x-content-type-options"], "nosniff");
    assert.equal(appRes.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(appRes.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
    assert.equal(appRes.headers["x-frame-options"], undefined);
    assert.match(appRes.headers["content-security-policy"], /frame-ancestors 'self' https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/);

    const apiRes = mockResponse();
    securityHeaders({ baseUrl: "http://hub.example" })({ path: "/api/me" }, apiRes, () => {});
    assert.equal(apiRes.headers["x-frame-options"], "DENY");
    assert.equal(apiRes.headers["strict-transport-security"], undefined);
    assert.match(apiRes.headers["content-security-policy"], /frame-ancestors 'none'/);
  });

  it("rate-limits per bucket and ip, then resets after the window", () => {
    let nowMs = 1000;
    const limiter = createRateLimiter({ now: () => nowMs, sweepIntervalMs: 60_000 });
    limiter.sweep.unref?.();
    clearInterval(limiter.sweep);
    const middleware = limiter.middleware({ bucket: "login", max: 2, windowMs: 1000 });
    const req = { ip: "127.0.0.1" };

    assert.equal(runMiddleware(middleware, req).nextCalled, true);
    assert.equal(runMiddleware(middleware, req).nextCalled, true);
    const limited = runMiddleware(middleware, req);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.body, { error: "too many requests" });
    assert.equal(limited.headers["retry-after"], 1);

    nowMs = 2001;
    assert.equal(runMiddleware(middleware, req).nextCalled, true);
    limiter.sweepExpired();
    assert.equal(limiter.buckets.size, 1);
  });

  it("uses a larger JSON body limit only for run artifact uploads", () => {
    const calls = [];
    const middleware = jsonBodyMiddleware({
      json: ({ limit }) => (req, _res, next) => {
        calls.push({ limit, method: req.method, path: req.path });
        next();
      }
    });

    assert.equal(runMiddleware(middleware, { method: "POST", path: "/api/runs/run_1/artifacts" }).nextCalled, true);
    assert.equal(runMiddleware(middleware, { method: "POST", path: "/api/runs/run_1/artifacts/" }).nextCalled, true);
    assert.equal(runMiddleware(middleware, { method: "GET", path: "/api/runs/run_1/artifacts" }).nextCalled, true);
    assert.equal(runMiddleware(middleware, { method: "POST", path: "/api/runs/run_1/events" }).nextCalled, true);

    assert.deepEqual(calls.map((call) => call.limit), ["25mb", "25mb", "1mb", "1mb"]);
  });

  it("normalizes known parser errors without leaking internals", () => {
    const seen = [];
    const handler = expressErrorHandler({ log: (error) => seen.push(error.message) });

    const tooLarge = mockResponse();
    handler(Object.assign(new Error("entity too large"), { status: 413 }), {}, tooLarge, () => {});
    assert.equal(tooLarge.statusCode, 413);
    assert.deepEqual(tooLarge.body, { error: "payload too large" });

    const invalidJson = mockResponse();
    handler(Object.assign(new Error("Unexpected token x"), { status: 400, type: "entity.parse.failed" }), {}, invalidJson, () => {});
    assert.equal(invalidJson.statusCode, 400);
    assert.deepEqual(invalidJson.body, { error: "invalid request body" });
    assert.deepEqual(seen, ["entity too large", "Unexpected token x"]);
  });

  it("hides unexpected errors behind a generic 500", () => {
    const handler = expressErrorHandler({ log: () => {} });
    const res = mockResponse();

    handler(new Error("database password leaked in stack"), {}, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "internal server error" });
  });
});

function runMiddleware(middleware, req) {
  const res = mockResponse();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { ...res, nextCalled };
}
