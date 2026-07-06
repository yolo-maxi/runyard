// Capacity clamp keeps a misconfigured runner from advertising thousands of
// slots and starving the queue logic. The cap is intentionally generous; a
// single VPS host is expected to be in the 1-8 range.
export const MAX_RUNNER_CAPACITY = 32;

export function normalizeRunnerCapacity(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_RUNNER_CAPACITY);
}

export function clampActiveRuns(value, capacity) {
  return Math.min(Math.max(Number(value) || 0, 0), capacity);
}

export function runnerHealthSummary({ live, capacity, load, authHealth }) {
  const issues = [];
  let score = 100;
  if (!live) {
    issues.push("offline");
    score -= 60;
  }
  if (capacity <= 0) {
    issues.push("no capacity");
    score -= 30;
  } else if ((load?.work || 0) >= capacity) {
    issues.push("work pool full");
    score -= 15;
  }
  for (const [provider, health] of Object.entries(authHealth || {})) {
    if (!health || typeof health !== "object" || health.ok !== false) continue;
    issues.push(`${provider} auth: ${health.error || "not ready"}`);
    score -= provider === "hub" ? 45 : 20;
  }
  score = Math.max(0, Math.min(100, score));
  const state = score >= 85 ? "healthy" : score >= 60 ? "degraded" : score > 0 ? "unhealthy" : "offline";
  return { score, state, issues };
}
