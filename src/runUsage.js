// Per-run model-call usage: record normalization, SQL, and aggregation.
//
// A usage record is one model call observed at the inference boundary — either
// captured by the Hub's metering gateway (source "gateway") or reported by the
// runner from the engine's structured TokenUsageReported events (source
// "runner"). Records are durable rows; every accepted record also folds into
// the run's `usage` aggregate so list/status payloads never need a join.
import { parseMaybeJson } from "./dbNormalization.js";

export const USAGE_SOURCES = new Set(["gateway", "runner", "api"]);

const MAX_LABEL_LENGTH = 200;
const MAX_TOKENS_PER_CALL = 1_000_000_000; // defensive cap: 1B tokens/call is garbage input
const MAX_COST_MICROS_PER_CALL = 100_000_000_000; // $100k/call

function cleanLabel(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().slice(0, MAX_LABEL_LENGTH);
  return text || fallback;
}

function cleanCount(value, { max = MAX_TOKENS_PER_CALL } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.min(Math.floor(num), max);
}

// Validate/normalize one reported model call. Returns { ok: true, value } or
// { ok: false, error }. Token counts must be non-negative finite numbers and at
// least one of prompt/completion/total must be positive — a run cannot "use"
// nothing, and accepting zero-rows would let a buggy reporter inflate `calls`.
export function normalizeUsageInput(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "usage body must be an object" };
  }
  const promptTokens = cleanCount(body.promptTokens ?? 0);
  const completionTokens = cleanCount(body.completionTokens ?? 0);
  if (promptTokens === null || completionTokens === null) {
    return { ok: false, error: "promptTokens/completionTokens must be non-negative numbers" };
  }
  const totalTokens = body.totalTokens === undefined || body.totalTokens === null
    ? promptTokens + completionTokens
    : cleanCount(body.totalTokens);
  if (totalTokens === null) {
    return { ok: false, error: "totalTokens must be a non-negative number" };
  }
  if (promptTokens + completionTokens + totalTokens === 0) {
    return { ok: false, error: "usage record must report at least one token" };
  }
  let costMicros = null;
  if (body.costMicros !== undefined && body.costMicros !== null) {
    costMicros = cleanCount(body.costMicros, { max: MAX_COST_MICROS_PER_CALL });
    if (costMicros === null) return { ok: false, error: "costMicros must be a non-negative number" };
  }
  const source = cleanLabel(body.source, "api");
  if (!USAGE_SOURCES.has(source)) {
    return { ok: false, error: `source must be one of ${[...USAGE_SOURCES].join(", ")}` };
  }
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata
    : {};
  return {
    ok: true,
    value: {
      provider: cleanLabel(body.provider),
      model: cleanLabel(body.model, "unknown"),
      promptTokens,
      completionTokens,
      totalTokens,
      costMicros,
      stepId: cleanLabel(body.stepId) || null,
      nodeId: cleanLabel(body.nodeId) || null,
      agentLabel: cleanLabel(body.agentLabel) || null,
      source,
      requestId: cleanLabel(body.requestId) || null,
      ts: cleanLabel(body.ts) || null,
      metadata
    }
  };
}

export function emptyRunUsage() {
  return {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    costMicros: 0,
    calls: 0,
    byModel: {},
    byProvider: {}
  };
}

function bucketFor(map, key) {
  if (!map[key]) {
    map[key] = { totalTokens: 0, promptTokens: 0, completionTokens: 0, costMicros: 0, calls: 0 };
  }
  return map[key];
}

function addToBucket(bucket, record) {
  bucket.totalTokens += record.totalTokens;
  bucket.promptTokens += record.promptTokens;
  bucket.completionTokens += record.completionTokens;
  if (record.costMicros != null) bucket.costMicros += record.costMicros;
  bucket.calls += 1;
}

// Fold one record into a run aggregate (pure — returns a new object). The
// aggregate is persisted on the run row so every existing run payload
// (list/detail/claim/terminal delivery) carries usage without a join.
export function applyUsageToAggregate(aggregate, record) {
  const base = aggregate && typeof aggregate === "object" ? aggregate : emptyRunUsage();
  const next = {
    ...emptyRunUsage(),
    ...base,
    byModel: { ...(base.byModel || {}) },
    byProvider: { ...(base.byProvider || {}) }
  };
  addToBucket(next, record);
  addToBucket(bucketFor(next.byModel, record.model || "unknown"), record);
  if (record.provider) addToBucket(bucketFor(next.byProvider, record.provider), record);
  return next;
}

const TOKEN_UNITS = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"]
];

export function formatTokenCount(value) {
  const num = Number(value) || 0;
  for (const [unit, suffix] of TOKEN_UNITS) {
    if (num >= unit) return `${(num / unit).toFixed(num >= 10 * unit ? 0 : 1)}${suffix}`;
  }
  return String(num);
}

export function usageEventMessage(record) {
  const parts = [`${record.model || "unknown"}: ${formatTokenCount(record.totalTokens)} tokens`];
  parts.push(`(prompt ${formatTokenCount(record.promptTokens)}, completion ${formatTokenCount(record.completionTokens)})`);
  if (record.costMicros != null) parts.push(`~$${(record.costMicros / 1_000_000).toFixed(4)}`);
  if (record.nodeId) parts.push(`node ${record.nodeId}`);
  return parts.join(" ");
}

export function runUsageRecordRow({ id, runId, value, createdAt }) {
  return {
    id,
    run_id: runId,
    ts: value.ts || createdAt,
    provider: value.provider || "",
    model: value.model || "unknown",
    prompt_tokens: value.promptTokens,
    completion_tokens: value.completionTokens,
    total_tokens: value.totalTokens,
    cost_micros: value.costMicros,
    step_id: value.stepId,
    node_id: value.nodeId,
    agent_label: value.agentLabel,
    source: value.source,
    request_id: value.requestId,
    metadata: JSON.stringify(value.metadata || {}),
    created_at: createdAt
  };
}

export function runUsageInsertQuery() {
  return {
    sql: `INSERT INTO run_usage_records (id, run_id, ts, provider, model, prompt_tokens, completion_tokens,
      total_tokens, cost_micros, step_id, node_id, agent_label, source, request_id, metadata, created_at)
     VALUES ($id, $run_id, $ts, $provider, $model, $prompt_tokens, $completion_tokens,
      $total_tokens, $cost_micros, $step_id, $node_id, $agent_label, $source, $request_id, $metadata, $created_at)`
  };
}

export function runUsageListQuery(runId, { limit = 1000 } = {}) {
  return {
    sql: "SELECT * FROM run_usage_records WHERE run_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
    params: [runId, Math.max(1, Math.min(10_000, Number(limit) || 1000))]
  };
}

// Reporters that can replay (a runner restarted mid-run re-reads the engine
// event stream from the top) send a stable requestId; a second insert with the
// same (run, requestId) is a duplicate observation of the same model call and
// must not double-count.
export function runUsageByRequestQuery(runId, requestId) {
  return {
    sql: "SELECT * FROM run_usage_records WHERE run_id = ? AND request_id = ? LIMIT 1",
    params: [runId, requestId]
  };
}

export function normalizeRunUsageRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    provider: row.provider || "",
    model: row.model || "unknown",
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0,
    costMicros: row.cost_micros === null || row.cost_micros === undefined ? null : Number(row.cost_micros),
    stepId: row.step_id || null,
    nodeId: row.node_id || null,
    agentLabel: row.agent_label || null,
    source: row.source || "",
    requestId: row.request_id || null,
    metadata: parseMaybeJson(row.metadata, {}),
    createdAt: row.created_at
  };
}
