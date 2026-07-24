import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Boot the real server against a throwaway data dir and verify the /docs
// mount serves the committed Fumadocs static export (docs-site/out). This is
// also the guard that a checkout/deploy can't silently lose the built docs:
// if docs-site/out is missing, the nested-route assertions below fail.

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-docs-site-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

describe("docs site", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it("serves the docs index with the relaxed docs CSP", async () => {
    const response = await fetch(`${baseUrl}/docs/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Runyard/);
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  });

  it("serves nested docs routes (quickstart, concepts, guides)", async () => {
    for (const route of ["/docs/quickstart/", "/docs/concepts/deep-links/", "/docs/concepts/ci/", "/docs/guides/api/", "/docs/guides/ci/", "/docs/guides/mcp/"]) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200, `${route} should be 200`);
      assert.match(await response.text(), /<html/i, `${route} should be a page`);
    }
  });

  it("redirects extensionless docs paths to their trailing-slash form", async () => {
    const response = await fetch(`${baseUrl}/docs/quickstart`, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.match(response.headers.get("location") || "", /\/docs\/quickstart\/$/);
  });

  it("answers unknown docs paths with the docs 404 page", async () => {
    const response = await fetch(`${baseUrl}/docs/never-a-page/`);
    assert.equal(response.status, 404);
  });

  it("serves the static search index", async () => {
    const response = await fetch(`${baseUrl}/docs/api/search`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotThrow(() => JSON.parse(body));
  });

  it("leaves the app, discovery docs, and strict CSP untouched outside /docs", async () => {
    const appPage = await fetch(`${baseUrl}/app`);
    assert.equal(appPage.status, 200);
    const csp = appPage.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org/);
    assert.equal((await fetch(`${baseUrl}/llms.txt`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/openapi.json`)).status, 200);
  });
});
