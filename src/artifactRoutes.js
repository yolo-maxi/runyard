import { readFileSync } from "node:fs";
import path from "node:path";

export function artifactDownloadPath(artifact, artifactDir) {
  const resolved = path.resolve(artifact.path);
  const root = path.resolve(artifactDir);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function safeDownloadName(name = "") {
  return path.basename(String(name || "artifact")).replace(/["\r\n]/g, "");
}

export function artifactDownloadTarget(artifact, artifactDir) {
  if (!artifact) return { ok: false, status: 404, body: { error: "artifact not found" } };
  const resolved = artifactDownloadPath(artifact, artifactDir);
  if (!resolved) return { ok: false, status: 400, body: { error: "artifact path outside storage root" } };
  return {
    ok: true,
    contentDisposition: `attachment; filename="${safeDownloadName(artifact.name)}"`,
    mimeType: artifact.mimeType,
    path: resolved
  };
}

export function createArtifactHandlers({
  artifactDir,
  getArtifact,
  getRun,
  listArtifacts,
  readFile = readFileSync,
  storeRunArtifact,
  withArtifactLinks
} = {}) {
  return {
    listRunArtifacts(req, res) {
      res.json({ artifacts: listArtifacts({ runId: req.params.id }).map(withArtifactLinks) });
    },

    createRunArtifact(req, res) {
      const runRecord = getRun(req.params.id);
      if (!runRecord) return res.status(404).json({ error: "run not found" });
      res.json({ artifact: storeRunArtifact(runRecord, req.body) });
    },

    listArtifacts(req, res) {
      res.json({ artifacts: listArtifacts({ q: req.query.q || "" }).map(withArtifactLinks) });
    },

    downloadArtifact(req, res) {
      const target = artifactDownloadTarget(getArtifact(req.params.id), artifactDir);
      if (!target.ok) return res.status(target.status).json(target.body);

      res.type(target.mimeType);
      // Force download so HTML/SVG artifacts never execute in the Hub origin.
      res.setHeader("content-disposition", target.contentDisposition);
      res.send(readFile(target.path));
    }
  };
}
