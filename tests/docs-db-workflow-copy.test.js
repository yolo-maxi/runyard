import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { openApiDocument, renderLlmsTxt } from "../src/discoveryDocs.js";

// Workflows are created by sending source bytes over API/MCP and stored as
// DB-backed bundles. No user-facing or discovery surface may instruct users
// to save workflow .tsx files on disk as the workflow-creation path.
const FORBIDDEN_CREATION_COPY = [
  /save a workflow\.tsx/i,
  /save a workflow file/i,
  /write a workflow file/i,
  /seeded from git/i,
  /drop a \.tsx/i,
  /place a \.tsx/i
];

const repoRoot = new URL("..", import.meta.url).pathname;

function collectJsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsxFiles(full));
    else if (/\.(jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("DB-backed workflow copy", () => {
  it("llms.txt tells agents to create workflows via API/MCP source bytes, never files on disk", () => {
    const text = renderLlmsTxt("https://hub.example");

    assert.match(text, /stored in the Hub database as immutable, versioned/);
    assert.match(text, /create_workflow \/ update_workflow/);
    assert.match(text, /Do NOT write workflow files to disk/);
    assert.match(text, /bare workflow\.entry file paths without source bytes are rejected/);
    for (const forbidden of FORBIDDEN_CREATION_COPY) assert.doesNotMatch(text, forbidden);
    assert.doesNotMatch(text, /\.smithers\/workflows/);
  });

  it("llms.txt advertises the full schedule lifecycle over HTTP and MCP", () => {
    const text = renderLlmsTxt("https://hub.example");

    assert.match(text, /Schedules \(cron and one-shot\)/);
    assert.match(text, /GET \/api\/schedules\/preview\?cron=/);
    assert.match(text, /\/enable \| \/disable \| \/run-now/);
    for (const tool of [
      "list_schedules", "get_schedule", "preview_schedule", "create_schedule",
      "update_schedule", "enable_schedule", "disable_schedule", "delete_schedule",
      "run_schedule_now"
    ]) {
      assert.ok(text.includes(tool), `llms.txt should advertise ${tool}`);
    }
    assert.match(text, /origin\.type "schedule"/);
  });

  it("OpenAPI summaries carry no file-based workflow-creation instructions", () => {
    const doc = JSON.stringify(openApiDocument({ baseUrl: "https://hub.example", version: "0.0.0" }));
    for (const forbidden of FORBIDDEN_CREATION_COPY) assert.doesNotMatch(doc, forbidden);
    assert.doesNotMatch(doc, /\.smithers\/workflows/);
  });

  it("MCP and CLI surface copy carries no file-based workflow-creation instructions", () => {
    for (const file of ["src/mcp.js", "src/cli.js"]) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      for (const forbidden of FORBIDDEN_CREATION_COPY) {
        assert.doesNotMatch(source, forbidden, `${file} should not match ${forbidden}`);
      }
    }
  });

  it("web app and public docs pages carry no file-based workflow-creation copy", () => {
    const files = [
      ...collectJsxFiles(path.join(repoRoot, "web")),
      path.join(repoRoot, "public/docs.html"),
      path.join(repoRoot, "public/landing.html"),
      path.join(repoRoot, "public/index.html")
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_CREATION_COPY) {
        assert.doesNotMatch(source, forbidden, `${path.relative(repoRoot, file)} should not match ${forbidden}`);
      }
      // The shipped template directory is not a user-facing browse/creation
      // surface; UI links must point at in-app catalog views instead.
      assert.ok(
        !source.includes('href="/workflow-templates/'),
        `${path.relative(repoRoot, file)} should not link to /workflow-templates/`
      );
    }
  });
});
