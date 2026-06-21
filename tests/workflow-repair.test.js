import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  workflowFileFromEntry,
  syncWorkflowToWorkspace
} = await import("../workflow-templates/workflows/workflow-repair.js");

function scaffold() {
  const root = mkdtempSync(path.join(os.tmpdir(), "smithers-repair-"));
  const repoRoot = path.join(root, "repo");
  const workspaceDir = path.join(root, "ws");
  mkdirSync(path.join(repoRoot, "workflow-templates", "workflows"), { recursive: true });
  mkdirSync(path.join(workspaceDir, ".smithers", "workflows"), { recursive: true });
  return { repoRoot, workspaceDir };
}

describe("workflow-repair helper", () => {
  it("extracts a safe workflow filename from a capability entry", () => {
    assert.equal(workflowFileFromEntry(".smithers/workflows/product-workflow.tsx"), "product-workflow.tsx");
    assert.equal(workflowFileFromEntry("", "product-workflow"), "product-workflow.tsx");
    // Only the bare leaf is taken, so mid-path traversal can never escape the
    // workflows dir — it just resolves to the safe leaf filename.
    assert.equal(workflowFileFromEntry(".smithers/workflows/../../secret.tsx"), "secret.tsx");
    // Non-workflow leaves are rejected.
    assert.equal(workflowFileFromEntry("../../etc/passwd"), "");
    assert.equal(workflowFileFromEntry("notes.md"), "");
  });

  it("syncs a repaired template from the repo into the runner workspace", () => {
    const { repoRoot, workspaceDir } = scaffold();
    const repoFile = path.join(repoRoot, "workflow-templates", "workflows", "product-workflow.tsx");
    const wsFile = path.join(workspaceDir, ".smithers", "workflows", "product-workflow.tsx");
    writeFileSync(wsFile, "// stale buggy copy\n");
    writeFileSync(repoFile, "// repaired copy\nexport const fixed = true;\n");

    const result = syncWorkflowToWorkspace({
      repoRoot,
      workspaceDir,
      entry: ".smithers/workflows/product-workflow.tsx"
    });
    assert.equal(result.ok, true);
    assert.equal(result.file, "product-workflow.tsx");
    assert.equal(readFileSync(wsFile, "utf8"), "// repaired copy\nexport const fixed = true;\n");
    assert.ok(result.bytes > 0);
  });

  it("creates the workspace workflows dir if missing", () => {
    const { repoRoot, workspaceDir } = scaffold();
    const repoFile = path.join(repoRoot, "workflow-templates", "workflows", "hello.tsx");
    writeFileSync(repoFile, "// hello\n");
    const result = syncWorkflowToWorkspace({ repoRoot, workspaceDir, slug: "hello", entry: "" });
    assert.equal(result.ok, true);
    assert.ok(existsSync(path.join(workspaceDir, ".smithers", "workflows", "hello.tsx")));
  });

  it("fails safely when the repaired source is missing", () => {
    const { repoRoot, workspaceDir } = scaffold();
    const result = syncWorkflowToWorkspace({ repoRoot, workspaceDir, entry: ".smithers/workflows/ghost.tsx" });
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/);
  });

  it("refuses an unrecognised / traversal entry", () => {
    const { repoRoot, workspaceDir } = scaffold();
    const result = syncWorkflowToWorkspace({ repoRoot, workspaceDir, entry: "../../../etc/passwd" });
    assert.equal(result.ok, false);
    assert.match(result.error, /unrecognised workflow entry/);
  });
});
