import {
  applyUsageToAggregate,
  emptyRunUsage,
  normalizeRunUsageRecord,
  normalizeUsageInput,
  runUsageByRequestQuery,
  runUsageInsertQuery,
  runUsageListQuery,
  runUsageRecordRow,
  usageEventMessage
} from "./runUsage.js";
import { estimateCostMicros, providerForModel } from "./modelPricing.js";

// Durable usage ingestion: one accepted record inserts a row, folds into the
// run's persisted `usage` aggregate, and emits a `run.usage` event — all in the
// same synchronous call so the event stream and the aggregate can never
// disagree. Replayed reports (same run + requestId) return the existing record
// without re-counting.
export function createRunUsageStore({ all, one, run, id, now, getRun, updateRun, addRunEvent }) {
  function recordRunUsage(runId, body) {
    const existingRun = getRun(runId);
    if (!existingRun) return { ok: false, code: 404, error: "run not found" };
    const normalized = normalizeUsageInput(body);
    if (!normalized.ok) return { ok: false, code: 400, error: normalized.error };
    const value = normalized.value;

    if (value.requestId) {
      const dupQuery = runUsageByRequestQuery(runId, value.requestId);
      const existing = normalizeRunUsageRecord(one(dupQuery.sql, dupQuery.params));
      if (existing) {
        return { ok: true, duplicate: true, record: existing, usage: existingRun.usage || emptyRunUsage() };
      }
    }

    if (!value.provider) value.provider = providerForModel(value.model);
    if (value.costMicros == null) {
      const estimated = estimateCostMicros(value);
      if (estimated != null) {
        value.costMicros = estimated;
        value.metadata = { ...value.metadata, costSource: "price-table" };
      }
    } else if (!value.metadata.costSource) {
      value.metadata = { ...value.metadata, costSource: "provider" };
    }

    const createdAt = now();
    const record = runUsageRecordRow({ id: id("usg"), runId, value, createdAt });
    run(runUsageInsertQuery().sql, record);
    const normalizedRecord = normalizeRunUsageRecord(record);

    const usage = applyUsageToAggregate(existingRun.usage, normalizedRecord);
    updateRun(runId, { usage });
    addRunEvent(runId, "run.usage", usageEventMessage(normalizedRecord), {
      record: {
        id: normalizedRecord.id,
        provider: normalizedRecord.provider,
        model: normalizedRecord.model,
        promptTokens: normalizedRecord.promptTokens,
        completionTokens: normalizedRecord.completionTokens,
        totalTokens: normalizedRecord.totalTokens,
        costMicros: normalizedRecord.costMicros,
        nodeId: normalizedRecord.nodeId,
        source: normalizedRecord.source
      },
      totals: {
        totalTokens: usage.totalTokens,
        costMicros: usage.costMicros,
        calls: usage.calls
      }
    });
    return { ok: true, duplicate: false, record: normalizedRecord, usage };
  }

  function listRunUsageRecords(runId, options = {}) {
    const query = runUsageListQuery(runId, options);
    return all(query.sql, query.params).map(normalizeRunUsageRecord);
  }

  function getRunUsage(runId) {
    const existingRun = getRun(runId);
    if (!existingRun) return null;
    return {
      runId: existingRun.id,
      usage: existingRun.usage || emptyRunUsage(),
      budget: existingRun.budget || null,
      records: listRunUsageRecords(runId)
    };
  }

  return { getRunUsage, listRunUsageRecords, recordRunUsage };
}
