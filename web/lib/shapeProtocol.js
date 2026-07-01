// Pure parsing of an Electric shape-log page into change ops + control signals.
// Shared by the browser shape stream (electricShape.js) and unit tests.
export function classifyShapeMessages(messages) {
  const ops = [];
  let upToDate = false;
  let mustRefetch = false;
  for (const m of messages || []) {
    const control = m?.headers?.control;
    if (control === "up-to-date") {
      upToDate = true;
    } else if (control === "must-refetch") {
      mustRefetch = true;
      break;
    } else if (m?.headers?.operation) {
      ops.push({ operation: m.headers.operation, key: m.key, value: m.value });
    }
  }
  return { ops, upToDate, mustRefetch };
}
