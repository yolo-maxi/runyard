export function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, "");
}

export function smithersEventMessage(line) {
  try {
    const parsed = JSON.parse(line);
    return stripAnsi(parsed.data ?? parsed.message ?? line);
  } catch {
    return stripAnsi(line);
  }
}

export function smithersEventsArtifactContent(lines = []) {
  return lines.map(smithersEventMessage).join("\n");
}
