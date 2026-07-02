import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import gatewayHttp, { json, urlencoded, staticFiles } from "../src/gatewayHttpCompat.js";

function createResponse() {
  const headers = new Map();
  return {
    body: "",
    // Node marks headersSent only once headers are flushed (on end/write), not on setHeader.
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    end(payload = "") {
      this.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
      this.headersSent = true;
      this.writableEnded = true;
    },
    reset() {
      headers.clear();
      this.body = "";
      this.headersSent = false;
      this.statusCode = 200;
      this.writableEnded = false;
      return this;
    }
  };
}

async function requestTrustProbe({ trustProxy, remoteAddress = "127.0.0.1", encrypted = false, headers = {} } = {}) {
  const app = gatewayHttp();
  app.set("trust proxy", trustProxy);
  app.get("/probe", (req, res) => {
    res.json({
      ip: req.ip,
      ips: req.ips,
      protocol: req.protocol
    });
  });

  const req = {
    headers,
    method: "GET",
    socket: {
      encrypted,
      remoteAddress
    },
    url: "/probe"
  };
  const res = createResponse();
  const handled = await app.handle(req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

describe("gateway HTTP compat routing", () => {
  it("returns the app 404 response for an unregistered path instead of falling through to the gateway stub", async () => {
    const app = gatewayHttp();
    app.use((_req, res) => res.status(404).json({ error: "app not found" }));
    const req = {
      headers: {},
      method: "GET",
      socket: {
        remoteAddress: "127.0.0.1"
      },
      url: "/does-not-exist"
    };
    const res = createResponse();

    const handled = await app.handle(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: "app not found" });
  });

  it("rejects app routes shadowed by light-gateway reserved paths", () => {
    const app = gatewayHttp();

    assert.throws(
      () => app.get("/health", (_req, res) => res.json({ ok: true })),
      /shadowed by Smithers gateway reserved path GET \/health/
    );
  });

  it("treats malformed encoded route params as not found instead of internal errors", async () => {
    const app = gatewayHttp();
    app.get("/api/runs/:id", (req, res) => res.json({ id: req.params.id }));
    const req = {
      headers: {},
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      url: "/api/runs/%E0%A4%A"
    };
    const res = createResponse();

    const handled = await app.handle(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: "not found" });
  });

  it("treats malformed encoded static paths as not found instead of internal errors", async () => {
    const app = gatewayHttp();
    app.use("/public", gatewayHttp.static(process.cwd()));
    const req = {
      headers: {},
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      url: "/public/%E0%A4%A"
    };
    const res = createResponse();

    const handled = await app.handle(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: "not found" });
  });
});

describe("gateway HTTP compat trust proxy", () => {
  it("uses X-Forwarded-For and X-Forwarded-Proto when a loopback peer is trusted", async () => {
    const body = await requestTrustProbe({
      trustProxy: "loopback",
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https"
      }
    });

    assert.equal(body.ip, "203.0.113.10");
    assert.deepEqual(body.ips, ["203.0.113.10"]);
    assert.equal(body.protocol, "https");
  });

  it("ignores forwarded headers when trust proxy is false", async () => {
    const body = await requestTrustProbe({
      trustProxy: false,
      remoteAddress: "10.0.0.5",
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https"
      }
    });

    assert.equal(body.ip, "10.0.0.5");
    assert.deepEqual(body.ips, []);
    assert.equal(body.protocol, "http");
  });

  it("trusts exactly one hop for hop-count 1", async () => {
    const body = await requestTrustProbe({
      trustProxy: 1,
      remoteAddress: "10.0.0.5",
      headers: {
        "x-forwarded-for": "198.51.100.25, 10.0.0.4",
        "x-forwarded-proto": "https"
      }
    });

    assert.equal(body.ip, "10.0.0.4");
    assert.deepEqual(body.ips, ["10.0.0.4"]);
    assert.equal(body.protocol, "https");
  });

  it("supports CIDR trust lists and false-like string settings", async () => {
    const trusted = await requestTrustProbe({
      trustProxy: "10.0.0.0/8, loopback",
      remoteAddress: "10.0.0.5",
      headers: {
        "x-forwarded-for": "198.51.100.25",
        "x-forwarded-proto": "https"
      }
    });
    assert.equal(trusted.ip, "198.51.100.25");
    assert.deepEqual(trusted.ips, ["198.51.100.25"]);
    assert.equal(trusted.protocol, "https");

    const untrusted = await requestTrustProbe({
      trustProxy: "false",
      remoteAddress: "10.0.0.5",
      headers: {
        "x-forwarded-for": "198.51.100.25",
        "x-forwarded-proto": "https"
      }
    });
    assert.equal(untrusted.ip, "10.0.0.5");
    assert.deepEqual(untrusted.ips, []);
    assert.equal(untrusted.protocol, "http");
  });
});

function bodyRequest({ method = "POST", url = "/ingest", headers = {}, chunks = [] } = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  };
}

describe("gateway HTTP compat route matching", () => {
  it("extracts and decodeURIComponent-decodes route params", async () => {
    const app = gatewayHttp();
    let captured = null;
    app.get("/runs/:runId/tasks/:taskId", (req, res) => {
      captured = req.params;
      res.json(req.params);
    });
    const req = {
      headers: {},
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      url: "/runs/a%20b/tasks/c%2Fd"
    };
    const res = createResponse();

    await app.handle(req, res);

    assert.deepEqual(captured, { runId: "a b", taskId: "c/d" });
  });

  it("collapses repeated query keys to the last value (documented divergence from Express arrays)", async () => {
    const app = gatewayHttp();
    let query = null;
    app.get("/search", (req, res) => {
      query = req.query;
      res.json(req.query);
    });
    const req = {
      headers: {},
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      url: "/search?tag=a&tag=b&tag=c&q=hello"
    };
    const res = createResponse();

    await app.handle(req, res);

    // Express would produce { tag: ["a", "b", "c"] }; this compat layer keeps the last value.
    assert.deepEqual(query, { tag: "c", q: "hello" });
  });
});

describe("gateway HTTP compat use() prefix matching", () => {
  it("matches a prefix on the exact path and sub-paths but not siblings", async () => {
    const app = gatewayHttp();
    const seen = [];
    app.use("/api", (req, _res, next) => {
      seen.push(req.path);
      next();
    });
    app.use((_req, res) => res.status(404).json({ error: "app not found" }));

    for (const url of ["/api", "/api/runs", "/apix", "/other"]) {
      const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url };
      await app.handle(req, createResponse());
    }

    assert.deepEqual(seen, ["/api", "/api/runs"]);
  });

  it("saves and restores _matchedUsePath across nested use() middleware", async () => {
    const app = gatewayHttp();
    const observed = [];
    app.use("/outer", (req, _res, next) => {
      observed.push(["outer", req._matchedUsePath]);
      next();
    });
    app.use("/outer/inner", (req, _res, next) => {
      observed.push(["inner", req._matchedUsePath]);
      next();
    });
    app.use((req, res) => {
      observed.push(["tail", req._matchedUsePath]);
      res.status(204).end();
    });

    const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "/outer/inner" };
    await app.handle(req, createResponse());

    assert.deepEqual(observed, [
      ["outer", "/outer"],
      ["inner", "/outer/inner"],
      // Each use entry restores _matchedUsePath after running; the root-mounted tail
      // middleware sets its own value to "" (path "/") while it runs.
      ["tail", ""]
    ]);
  });
});

describe("gateway HTTP compat staticFiles", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runyard-static-"));
  writeFileSync(path.join(root, "hello.txt"), "hi there");
  mkdirSync(path.join(root, "sub"));
  writeFileSync(path.join(root, "sub", "nested.txt"), "nested");
  const secretDir = mkdtempSync(path.join(os.tmpdir(), "runyard-secret-"));
  writeFileSync(path.join(secretDir, "secret.txt"), "top secret");

  function staticReq(pathValue, matchedUsePath = "/public") {
    return {
      method: "GET",
      path: pathValue,
      socket: { remoteAddress: "127.0.0.1" },
      _matchedUsePath: matchedUsePath === "/" ? "" : matchedUsePath
    };
  }

  it("serves a file inside the root with the right content-type", () => {
    const mw = staticFiles(root);
    const res = createResponse();
    let sentFile = null;
    res.sendFile = (filePath) => { sentFile = filePath; };
    let nextCalled = false;
    mw(staticReq("/public/hello.txt"), res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(sentFile, path.join(root, "hello.txt"));
    assert.equal(res.getHeader("content-type"), "text/plain; charset=utf-8");
  });

  it("falls through to next() when the resolved path escapes the root", () => {
    const mw = staticFiles(root);
    const res = createResponse();
    let nextCalled = false;
    // ../ traversal that resolves outside the root must not be served.
    const escapeName = path.join("..", path.basename(secretDir), "secret.txt");
    mw(staticReq(`/public/${escapeName}`), res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.writableEnded, false);
  });

  it("falls through to next() for a missing file", () => {
    const mw = staticFiles(root);
    const res = createResponse();
    let nextCalled = false;
    mw(staticReq("/public/nope.txt"), res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
  });
});

describe("gateway HTTP compat body parsers", () => {
  it("parses a JSON body", async () => {
    const req = bodyRequest({
      headers: { "content-type": "application/json" },
      chunks: ['{"name":"runyard","n":2}']
    });
    let nextErr = "unset";
    await json()(req, createResponse(), (err) => { nextErr = err; });
    assert.equal(nextErr, undefined);
    assert.deepEqual(req.body, { name: "runyard", n: 2 });
  });

  it("returns a 413 error when the JSON body exceeds the limit", async () => {
    const req = bodyRequest({
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({ blob: "x".repeat(100) })]
    });
    let error = null;
    await json({ limit: "16b" })(req, createResponse(), (err) => { error = err; });
    assert.ok(error instanceof Error);
    assert.equal(error.status, 413);
  });

  it("returns a 400 entity.parse.failed error on invalid JSON", async () => {
    const req = bodyRequest({
      headers: { "content-type": "application/json" },
      chunks: ["{not json}"]
    });
    let error = null;
    await json()(req, createResponse(), (err) => { error = err; });
    assert.ok(error instanceof Error);
    assert.equal(error.status, 400);
    assert.equal(error.type, "entity.parse.failed");
  });

  it("parses a urlencoded body", async () => {
    const req = bodyRequest({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      chunks: ["a=1&b=two&b=three"]
    });
    let nextErr = "unset";
    await urlencoded()(req, createResponse(), (err) => { nextErr = err; });
    assert.equal(nextErr, undefined);
    assert.deepEqual(req.body, { a: "1", b: "three" });
  });

  it("defaults body to {} when the content-type does not match", async () => {
    const req = bodyRequest({
      headers: { "content-type": "text/plain" },
      chunks: ["ignored"]
    });
    await json()(req, createResponse(), () => {});
    assert.deepEqual(req.body, {});
  });
});

describe("gateway HTTP compat error propagation", () => {
  it("routes a thrown handler error into a 4-arity error middleware", async () => {
    const app = gatewayHttp();
    app.get("/boom", () => {
      const error = new Error("kaboom");
      error.status = 418;
      throw error;
    });
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: error.message });
    });

    const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "/boom" };
    const res = createResponse();
    await app.handle(req, res);

    assert.equal(res.statusCode, 418);
    assert.deepEqual(JSON.parse(res.body), { error: "kaboom" });
  });

  it("routes next(error) into the error middleware", async () => {
    const app = gatewayHttp();
    app.get("/next-error", (_req, _res, next) => next(new Error("via next")));
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

    const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "/next-error" };
    const res = createResponse();
    await app.handle(req, res);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: "via next" });
  });

  it("falls back to a 500 JSON body when no error middleware handles the error", async () => {
    const app = gatewayHttp();
    app.get("/unhandled", () => { throw new Error("nope"); });

    const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "/unhandled" };
    const res = createResponse();
    await app.handle(req, res);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: "internal server error" });
  });
});

describe("gateway HTTP compat response helpers", () => {
  function decorated() {
    const app = gatewayHttp();
    let captured = null;
    app.get("/r", (_req, res) => { captured = res; res.end(); });
    return async () => {
      const req = { headers: {}, method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "/r" };
      const res = createResponse();
      await app.handle(req, res);
      // res is now decorated; reset the mock state so helper assertions start from a clean slate.
      return captured.reset();
    };
  }

  it("status() sets statusCode and chains", async () => {
    const res = await decorated()();
    assert.equal(res.status(201), res);
    assert.equal(res.statusCode, 201);
  });

  it("set() applies a header map and type() maps extensions and mime strings", async () => {
    const res = await decorated()();
    res.set({ "X-Test": "1", "X-Other": "2" });
    assert.equal(res.getHeader("x-test"), "1");
    assert.equal(res.getHeader("x-other"), "2");
    res.type("json");
    assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
    res.type("text/custom");
    assert.equal(res.getHeader("content-type"), "text/custom");
  });

  it("json() and send() serialize payloads", async () => {
    const jsonRes = await decorated()();
    jsonRes.json({ ok: true });
    assert.equal(jsonRes.body, '{"ok":true}\n');
    assert.equal(jsonRes.getHeader("content-type"), "application/json; charset=utf-8");

    const sendObj = await decorated()();
    sendObj.send({ a: 1 });
    assert.equal(sendObj.body, '{"a":1}\n');

    const sendStr = await decorated()();
    sendStr.send("hello");
    assert.equal(sendStr.body, "hello");
    assert.equal(sendStr.getHeader("content-type"), "text/html; charset=utf-8");
  });

  it("redirect() sets status and location", async () => {
    const res = await decorated()();
    res.redirect("/elsewhere");
    assert.equal(res.statusCode, 302);
    assert.equal(res.getHeader("location"), "/elsewhere");

    const res2 = await decorated()();
    res2.redirect(301, "/perm");
    assert.equal(res2.statusCode, 301);
    assert.equal(res2.getHeader("location"), "/perm");
  });

  it("cookie() and clearCookie() append to set-cookie", async () => {
    const res = await decorated()();
    res.cookie("session", "abc", { httpOnly: true, path: "/" });
    res.cookie("theme", "dark");
    res.clearCookie("session");

    const cookies = res.getHeader("set-cookie");
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 3);
    assert.match(cookies[0], /^session=abc; Path=\/; HttpOnly$/);
    assert.match(cookies[1], /^theme=dark$/);
    assert.match(cookies[2], /^session=; .*Max-Age=0/);
  });
});
