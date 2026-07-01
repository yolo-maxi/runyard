import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  artifactDownloadPath,
  artifactDownloadTarget,
  createArtifactHandlers,
  safeDownloadName
} from "../src/artifactRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query };
}

function harness(overrides = {}) {
  const artifactDir = overrides.artifactDir || "/tmp/runyard-artifacts";
  const runs = new Map([["run_1", { id: "run_1", capabilitySlug: "test" }]]);
  const artifacts = [
    {
      id: "art_1",
      runId: "run_1",
      name: "report.txt",
      mimeType: "text/plain",
      path: path.join(artifactDir, "runs", "run_1", "report.txt")
    },
    {
      id: "art_outside",
      runId: "run_1",
      name: "outside.html",
      mimeType: "text/html",
      path: "/tmp/outside.html"
    }
  ];
  const stored = [];
  const handlers = createArtifactHandlers({
    artifactDir,
    getArtifact: (id) => artifacts.find((artifact) => artifact.id === id) || null,
    getRun: (id) => runs.get(id) || null,
    listArtifacts: ({ runId = "", q = "" } = {}) => artifacts
      .filter((artifact) => !runId || artifact.runId === runId)
      .filter((artifact) => !q || artifact.name.includes(q)),
    readFile: (file) => Buffer.from(`read:${file}`),
    storeRunArtifact: (runRecord, body) => {
      const artifact = {
        id: `art_${stored.length + 2}`,
        runId: runRecord.id,
        name: body.name,
        mimeType: body.mimeType || "application/octet-stream",
        path: path.join(artifactDir, body.name)
      };
      stored.push({ runRecord, body, artifact });
      return artifact;
    },
    withArtifactLinks: (artifact) => ({ ...artifact, deepLink: `/app#artifacts/${artifact.id}` })
  });
  return { artifactDir, artifacts, handlers, stored };
}

describe("artifact route helpers", () => {
  it("validates download paths stay inside the artifact directory", () => {
    assert.equal(
      artifactDownloadPath({ path: "/var/runyard/artifacts/runs/run_1/report.txt" }, "/var/runyard/artifacts"),
      "/var/runyard/artifacts/runs/run_1/report.txt"
    );
    assert.equal(artifactDownloadPath({ path: "/var/runyard/artifacts-neighbor/report.txt" }, "/var/runyard/artifacts"), null);
    assert.equal(artifactDownloadPath({ path: "/var/runyard/other/report.txt" }, "/var/runyard/artifacts"), null);
  });

  it("sanitizes download filenames for content-disposition", () => {
    assert.equal(safeDownloadName("../evil\r\nname.txt"), "evilname.txt");
    assert.equal(safeDownloadName('quote".txt'), "quote.txt");
    assert.equal(safeDownloadName(""), "artifact");
  });

  it("builds a safe download target or a route error", () => {
    assert.deepEqual(
      artifactDownloadTarget({
        name: "../report.html",
        mimeType: "text/html",
        path: "/var/runyard/artifacts/runs/run_1/report.html"
      }, "/var/runyard/artifacts"),
      {
        ok: true,
        contentDisposition: 'attachment; filename="report.html"',
        mimeType: "text/html",
        path: "/var/runyard/artifacts/runs/run_1/report.html"
      }
    );
    assert.deepEqual(artifactDownloadTarget(null, "/var/runyard/artifacts"), {
      ok: false,
      status: 404,
      body: { error: "artifact not found" }
    });
    assert.deepEqual(artifactDownloadTarget({ path: "/var/runyard/other/report.txt" }, "/var/runyard/artifacts"), {
      ok: false,
      status: 400,
      body: { error: "artifact path outside storage root" }
    });
  });

  it("lists run-scoped and global artifacts with links", () => {
    const { handlers } = harness();

    const runRes = response();
    handlers.listRunArtifacts(req({ params: { id: "run_1" } }), runRes);
    assert.equal(runRes.body.artifacts.length, 2);
    assert.equal(runRes.body.artifacts[0].deepLink, "/app#artifacts/art_1");

    const globalRes = response();
    handlers.listArtifacts(req({ query: { q: "report" } }), globalRes);
    assert.deepEqual(globalRes.body.artifacts.map((artifact) => artifact.id), ["art_1"]);
  });

  it("stores run artifacts and returns 404 for missing runs", () => {
    const { handlers, stored } = harness();

    const createRes = response();
    handlers.createRunArtifact(req({ params: { id: "run_1" }, body: { name: "log.txt" } }), createRes);
    assert.equal(createRes.body.artifact.id, "art_2");
    assert.equal(stored[0].runRecord.id, "run_1");

    const missingRes = response();
    handlers.createRunArtifact(req({ params: { id: "missing" }, body: { name: "log.txt" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingRes.body.error, "run not found");
  });

  it("downloads artifacts as attachments and blocks escaped paths", () => {
    const { artifactDir, handlers } = harness();

    const downloadRes = response();
    handlers.downloadArtifact(req({ params: { id: "art_1" } }), downloadRes);
    assert.equal(downloadRes.typeValue, "text/plain");
    assert.equal(downloadRes.headers["content-disposition"], 'attachment; filename="report.txt"');
    assert.deepEqual(downloadRes.body, Buffer.from(`read:${path.join(artifactDir, "runs", "run_1", "report.txt")}`));

    const outsideRes = response();
    handlers.downloadArtifact(req({ params: { id: "art_outside" } }), outsideRes);
    assert.equal(outsideRes.statusCode, 400);
    assert.equal(outsideRes.body.error, "artifact path outside storage root");

    const missingRes = response();
    handlers.downloadArtifact(req({ params: { id: "missing" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);
  });
});
