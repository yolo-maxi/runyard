export const FAILURE_ALERT_WINDOW_MS = 60 * 60_000;
export const FAILURE_ALERT_THRESHOLD = 3;

export function failureAlertLevel(status) {
  return status === "provider_limited" || status === "infra_unavailable" ? "warning" : "info";
}

export function maybeRecordFailureClassAlert(status, {
  countRuns,
  latestAlert,
  recordAlert,
  nowMs = Date.now()
} = {}) {
  if (!status || status === "failed") return false;
  const since = new Date(nowMs - FAILURE_ALERT_WINDOW_MS).toISOString();
  const count = countRuns({ status, since, includeInternal: true });
  if (count < FAILURE_ALERT_THRESHOLD) return false;
  const kind = `failure:${status}`;
  const latest = latestAlert(kind);
  if (latest?.createdAt && nowMs - Date.parse(latest.createdAt) < FAILURE_ALERT_WINDOW_MS) return false;
  recordAlert({
    kind,
    level: failureAlertLevel(status),
    title: `Repeated ${status} runs`,
    message: `${count} runs ended as ${status} in the last hour.`,
    data: { status, count, windowMinutes: 60 }
  });
  return true;
}
