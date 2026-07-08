import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDocsUpdateBrief,
  capText,
  docsGlobsFor,
  globToRegExp,
  normalizeReleasePayload,
  parseNameStatus,
  pickPreviousTag,
  sanitizeGitRef,
  selectDocRelevantChanges
} from "../workflow-templates/workflows/docs-update-lib.js";

describe("docs-update lib: git ref hygiene", () => {
  it("accepts normal tags/branches and rejects flag/option smuggling", () => {
    assert.equal(sanitizeGitRef("v0.3.10"), "v0.3.10");
    assert.equal(sanitizeGitRef("release/2026-07"), "release/2026-07");
    assert.equal(sanitizeGitRef("  v1.2.3 "), "v1.2.3");
    assert.equal(sanitizeGitRef("--upload-pack=/bin/sh"), "");
    assert.equal(sanitizeGitRef("-rf"), "");
    assert.equal(sanitizeGitRef("v1..v2"), "");
    assert.equal(sanitizeGitRef("tag with spaces"), "");
    assert.equal(sanitizeGitRef("$(reboot)"), "");
    assert.equal(sanitizeGitRef(""), "");
  });
});

describe("docs-update lib: release payload normalization", () => {
  it("normalizes a GitHub release event (as delivered under input.payload)", () => {
    const normalized = normalizeReleasePayload({
      payload: {
        action: "published",
        release: {
          tag_name: "v2.0.0",
          name: "Big rewrite",
          html_url: "https://github.com/acme/widget/releases/tag/v2.0.0",
          body: "## What changed\n- everything",
          prerelease: false
        },
        repository: { full_name: "acme/widget" }
      }
    });
    assert.equal(normalized.releaseTag, "v2.0.0");
    assert.equal(normalized.releaseName, "Big rewrite");
    assert.equal(normalized.releaseUrl, "https://github.com/acme/widget/releases/tag/v2.0.0");
    assert.match(normalized.releaseNotes, /everything/);
    assert.equal(normalized.repository, "acme/widget");
  });

  it("prefers explicit flat fields over payload-derived values", () => {
    const normalized = normalizeReleasePayload({
      releaseTag: "v3.1.0",
      fromRef: "v3.0.0",
      payload: { release: { tag_name: "v9.9.9", previous_tag_name: "v9.9.8" } }
    });
    assert.equal(normalized.releaseTag, "v3.1.0");
    assert.equal(normalized.previousTag, "v3.0.0");
  });

  it("sanitizes hostile refs out of payloads and caps notes", () => {
    const normalized = normalizeReleasePayload({
      payload: { release: { tag_name: "--exec=evil", body: "x".repeat(9000) } }
    });
    assert.equal(normalized.releaseTag, "");
    assert.ok(normalized.releaseNotes.length <= 4001);
  });
});

describe("docs-update lib: previous tag selection", () => {
  const tags = ["v0.1.0", "v0.2.0", "v0.3.0", "v0.3.1"];
  it("picks the tag immediately preceding the current one", () => {
    assert.equal(pickPreviousTag(tags, "v0.3.1"), "v0.3.0");
    assert.equal(pickPreviousTag(tags, "v0.2.0"), "v0.1.0");
  });
  it("handles the first tag and unknown tags", () => {
    assert.equal(pickPreviousTag(tags, "v0.1.0"), "");
    assert.equal(pickPreviousTag(tags, "v9.9.9"), "v0.3.1");
    assert.equal(pickPreviousTag([], "v1.0.0"), "");
  });
});

describe("docs-update lib: name-status parsing", () => {
  it("parses modify/add/delete and uses the post-rename path", () => {
    const parsed = parseNameStatus("M\tsrc/api.js\nA\tsrc/new.js\nD\told.js\nR100\ta.js\tb/renamed.js\n\n");
    assert.deepEqual(parsed, [
      { status: "M", path: "src/api.js" },
      { status: "A", path: "src/new.js" },
      { status: "D", path: "old.js" },
      { status: "R", path: "b/renamed.js" }
    ]);
  });
});

describe("docs-update lib: diff selection (Runyard-shaped repo)", () => {
  const changes = parseNameStatus(
    [
      "M\tsrc/apiSurface.js",
      "M\tsrc/mcpTools.js",
      "M\tpnpm-lock.yaml",
      "M\tpublic/app.js.map",
      "M\ttests/api-surface.test.js",
      "A\tdocs-site/content/docs/guides/api.mdx",
      "M\tdocs-site/out/index.html",
      "M\tREADME.md",
      "M\tweb/views/Home.jsx"
    ].join("\n")
  );
  const selection = selectDocRelevantChanges({
    changes,
    docsPath: "docs-site/content/docs",
    docsFramework: "fumadocs"
  });

  it("routes source changes to docRelevant, docs to docsChanged, noise to ignored", () => {
    assert.deepEqual(selection.docRelevant.map((change) => change.path), [
      "src/apiSurface.js",
      "src/mcpTools.js",
      "web/views/Home.jsx"
    ]);
    // fumadocs hint claims docs-site/** (content and generated out) plus README
    assert.deepEqual(selection.docsChanged.map((change) => change.path).sort(), [
      "README.md",
      "docs-site/content/docs/guides/api.mdx",
      "docs-site/out/index.html"
    ]);
    assert.deepEqual(selection.ignored.map((change) => change.path).sort(), [
      "pnpm-lock.yaml",
      "public/app.js.map",
      "tests/api-surface.test.js"
    ]);
  });
});

describe("docs-update lib: diff selection (non-Runyard mkdocs-shaped repo)", () => {
  // A Python service documented with MkDocs: docs live in documentation/,
  // only the package source counts as doc-relevant via an adapter.
  const changes = parseNameStatus(
    [
      "M\twidget/api/routes.py",
      "M\twidget/core/engine.py",
      "M\tsetup.cfg",
      "M\tpoetry.lock",
      "M\ttests/test_routes.py",
      "M\tdocumentation/reference/api.md",
      "M\tmkdocs.yml",
      "M\tREADME.md",
      "M\tscripts/dev.sh"
    ].join("\n")
  );
  const selection = selectDocRelevantChanges({
    changes,
    docsPath: "documentation",
    docsFramework: "mkdocs",
    adapter: {
      sourceGlobs: ["widget/**", "setup.cfg"],
      ignoreGlobs: ["poetry.lock"]
    }
  });

  it("respects docsPath, mkdocs hint, and adapter source/ignore globs", () => {
    assert.deepEqual(selection.docRelevant.map((change) => change.path), [
      "widget/api/routes.py",
      "widget/core/engine.py",
      "setup.cfg"
    ]);
    assert.deepEqual(selection.docsChanged.map((change) => change.path).sort(), [
      "README.md",
      "documentation/reference/api.md",
      "mkdocs.yml"
    ]);
    // poetry.lock via adapter ignore; tests via defaults; scripts/dev.sh
    // because the adapter's sourceGlobs exclude it.
    assert.deepEqual(selection.ignored.map((change) => change.path).sort(), [
      "poetry.lock",
      "scripts/dev.sh",
      "tests/test_routes.py"
    ]);
  });

  it("reports empty docRelevant as a no-op signal", () => {
    const noop = selectDocRelevantChanges({
      changes: parseNameStatus("M\tpoetry.lock\nM\tdocumentation/index.md"),
      docsPath: "documentation",
      docsFramework: "mkdocs"
    });
    assert.equal(noop.docRelevant.length, 0);
    assert.equal(noop.counts.docsChanged, 1);
  });
});

describe("docs-update lib: glob semantics", () => {
  it("handles the shapes the defaults rely on", () => {
    assert.ok(globToRegExp("**/node_modules/**").test("a/node_modules/b.js"));
    assert.ok(globToRegExp("**/node_modules/**").test("node_modules/b.js"));
    assert.ok(globToRegExp("docs/**").test("docs/deep/nested/page.md"));
    assert.ok(!globToRegExp("docs/**").test("src/docs.js"));
    assert.ok(globToRegExp("*.md").test("README.md"));
    assert.ok(!globToRegExp("*.md").test("docs/README.md"));
    assert.ok(globToRegExp("**/*.test.*").test("tests/api.test.js"));
  });

  it("derives docs globs per framework", () => {
    assert.deepEqual(docsGlobsFor({ docsPath: "documentation", docsFramework: "mkdocs" }), [
      "documentation/**",
      "README*",
      "*.md",
      "mkdocs.yml",
      "mkdocs.yaml"
    ]);
  });
});

describe("docs-update lib: agent brief", () => {
  it("labels payload metadata untrusted and encodes the mode", () => {
    const brief = buildDocsUpdateBrief({
      release: { releaseTag: "v2.0.0", releaseNotes: "notes here" },
      selection: {
        docRelevant: [{ status: "M", path: "src/api.js" }],
        docsChanged: [{ status: "M", path: "docs/api.md" }],
        ignored: []
      },
      fromRef: "v1.0.0",
      toRef: "v2.0.0",
      docsPath: "docs",
      updateMode: "propose",
      diffStat: "1 file changed",
      diffs: "diff --git a/src/api.js",
      docsTree: "docs/api.md"
    });
    assert.match(brief, /untrusted metadata/);
    assert.match(brief, /Do NOT edit any files/);
    assert.match(brief, /\[M\] src\/api\.js/);
    assert.match(brief, /Never scan the whole repository/);

    const applyBrief = buildDocsUpdateBrief({
      release: {},
      selection: { docRelevant: [{ status: "M", path: "a.js" }], docsChanged: [], ignored: [] },
      fromRef: "v1",
      toRef: "v2",
      docsPath: "docs",
      updateMode: "apply"
    });
    assert.match(applyBrief, /Edit files under docs only/);
  });

  it("caps long text with an explicit marker", () => {
    const capped = capText("x".repeat(100), 10);
    assert.match(capped, /truncated at 10 chars/);
  });
});
