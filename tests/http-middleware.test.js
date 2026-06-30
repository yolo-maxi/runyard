import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter, securityHeaders } from "../src/httpMiddleware.js";

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
});

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function runMiddleware(middleware, req) {
  const res = mockResponse();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { ...res, nextCalled };
}
