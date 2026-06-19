const REPORT_FIELDS = ["report", "markdown", "summaryMarkdown"];

function safeArtifactName(value, fallback) {
  const raw = String(value || fallback || "report.md")
    .replace(/[/\\]/g, "-")
    .replace(/[\0\r\n]/g, "")
    .trim();
  const name = raw || fallback || "report.md";
  return /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.md`;
}

function uniqueName(name, seen) {
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  const match = name.match(/^(.*?)(\.[^.]+)?$/);
  const base = match?.[1] || "report";
  const ext = match?.[2] || ".md";
  let index = 2;
  while (seen.has(`${base}-${index}${ext}`)) index += 1;
  const next = `${base}-${index}${ext}`;
  seen.add(next);
  return next;
}

export function markdownArtifactsFromOutputs(outputs = {}) {
  const artifacts = [];
  const seen = new Set();
  for (const [nodeId, output] of Object.entries(outputs || {})) {
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    for (const field of REPORT_FIELDS) {
      const content = output[field];
      if (typeof content !== "string" || !content.trim()) continue;
      const requestedName =
        typeof output.artifactName === "string"
          ? output.artifactName
          : typeof output.artifact_name === "string"
            ? output.artifact_name
            : "";
      const fallback = `${nodeId}-${field}.md`;
      artifacts.push({
        name: uniqueName(safeArtifactName(requestedName, fallback), seen),
        mimeType: "text/markdown",
        content,
        metadata: {
          generatedBy: "smithers-runner",
          sourceNode: nodeId,
          sourceField: field
        }
      });
      break;
    }
  }
  return artifacts;
}
