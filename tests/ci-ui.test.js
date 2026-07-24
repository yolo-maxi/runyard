import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Source-assertion UI test for the CI surfaces (repo overview/detail + the
// run-detail CI section), following the *-ui.test.js convention: pin the
// code shape that makes the pages real — API calls, empty/error states,
// admin gating, navigation, deep links, and stylesheet coverage.

const repositories = readFileSync(new URL("../web/views/Repositories.jsx", import.meta.url), "utf8");
const ciParts = readFileSync(new URL("../web/components/CiParts.jsx", import.meta.url), "utf8");
const runDetail = readFileSync(new URL("../web/views/RunDetail.jsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../web/app/Shell.jsx", import.meta.url), "utf8");
const content = readFileSync(new URL("../web/app/Content.jsx", import.meta.url), "utf8");
const router = readFileSync(new URL("../web/lib/router.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const bundle = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

describe("CI web surfaces", () => {
  it("repositories overview lists repos, surfaces app health, and gates admin actions", () => {
    assert.match(repositories, /api\("\/api\/ci\/repos"\)/);
    assert.match(repositories, /\/api\/ci\/github-app/);
    assert.match(repositories, /meIsAdmin\(me\)/);
    assert.match(repositories, /No repositories connected\./);
    assert.match(repositories, /Repositories connect <strong>disabled<\/strong>/);
    assert.match(repositories, /enable" : "disable/);
    assert.match(repositories, /\/api\/ci\/repos\/sync/);
  });

  it("repository detail shows trust, config validation states, and recent pipelines", () => {
    assert.match(repositories, /\/config`\)/, "fetches the validated config");
    assert.match(repositories, /Configuration invalid/);
    assert.match(repositories, /No <code>\.runyard\/ci\.yml<\/code>/);
    assert.match(repositories, /No pipelines yet\./);
    assert.match(repositories, /runyard ci dispatch/);
  });

  it("run detail folds in a CI section for pipeline and job runs", () => {
    assert.match(runDetail, /RunCiSection/);
    assert.match(runDetail, /run\.input\?\.__ci/);
    assert.match(runDetail, /"CI pipeline" : "CI job"/);
    assert.match(repositories, /\/api\/ci\/pipelines\//);
  });

  it("CI parts render the job DAG with run links, states, and check chips", () => {
    assert.match(ciParts, /deepLinks\.run\(job\.run\.id\)/);
    assert.match(ciParts, /StatusBadge/);
    assert.match(ciParts, /needs \$\{job\.needs\.join/);
    assert.match(ciParts, /merge candidate of/);
    assert.match(ciParts, /checkAttempts/);
  });

  it("navigation reaches #repositories from sidebar, mobile nav, and the router grammar", () => {
    assert.match(shell, /\["repositories", "repositories"\]/);
    assert.match(shell, /SidebarButton view="repositories"/);
    assert.match(shell, /href="#repositories"/);
    assert.match(content, /view === "repositories"/);
    assert.match(content, /RepositoryDetail key=\{segments\[1\]\}/);
    assert.match(router, /repositories: \(\) => "#repositories"/);
    assert.match(router, /repository: \(id\)/);
  });

  it("the stylesheet covers the CI classes, including mobile behavior", () => {
    for (const selector of [".ci-job-row", ".ci-provenance", ".ci-repo-chips", ".ci-config-errors", ".ci-check-lagging"]) {
      assert.ok(styles.includes(selector), `styles.css misses ${selector}`);
    }
    assert.match(styles, /\.ci-provenance \{ grid-template-columns: 1fr;/, "provenance stacks on mobile");
  });

  it("the committed bundle was rebuilt with the CI surfaces", () => {
    assert.ok(bundle.includes("#repositories"), "public/app.js must be rebuilt (pnpm build:web) after web/ changes");
    assert.ok(bundle.includes("/api/ci/repos"), "bundle carries the CI API calls");
  });
});
