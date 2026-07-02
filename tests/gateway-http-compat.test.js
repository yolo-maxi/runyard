import { describe, it } from "node:test";
import assert from "node:assert/strict";
import gatewayHttp from "../src/gatewayHttpCompat.js";

function createResponse() {
  const headers = new Map();
  return {
    body: "",
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
      this.headersSent = true;
    },
    end(payload = "") {
      this.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
      this.headersSent = true;
      this.writableEnded = true;
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
