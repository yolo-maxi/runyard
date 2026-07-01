export function diagnosticArtifactScore(artifact) {
  const name = String(artifact?.name || "").toLowerCase();
  const mime = String(artifact?.mimeType || "").toLowerCase();
  let score = 0;
  if (/error|failure|stderr|stdout|trace|diagnostic|panic|crash|core\b/.test(name)) score += 3;
  if (/\.(?:log|txt)$/.test(name)) score += 1;
  if (mime === "text/x-log") score += 2;
  if (mime.startsWith("text/")) score += 1;
  return score;
}

export function diagnosticArtifacts(artifacts, { withArtifactLinks = (artifact) => artifact } = {}) {
  return (artifacts || [])
    .map((artifact) => ({ artifact, score: diagnosticArtifactScore(artifact) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || String(b.artifact.createdAt || "").localeCompare(String(a.artifact.createdAt || ""))
    )
    .slice(0, 6)
    .map((entry) => withArtifactLinks(entry.artifact));
}
