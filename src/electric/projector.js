// SQLite -> Postgres projector for the RunYard Electric demo.
//
// SQLite remains the system of record. This projector deterministically mirrors
// the read-relevant tables into Postgres so ElectricSQL can sync them to clients
// as live shape logs. It is decoupled sync glue by design: it only ever reads
// SQLite and writes Postgres, so it can never corrupt the source of truth.
//
// Strategy:
//   * Small mutable tables (runs, runners, capabilities, approvals, artifacts):
//     full mirror each tick (upsert all rows + delete rows no longer present).
//     Handles inserts, updates AND deletes with trivial cost at demo scale.
//   * run_events (immutable, append-only, potentially large): incremental append
//     keyed on the SQLite rowid, a stable monotonic per-insert cursor.
import { db } from "../db.js";
import { buildMultiUpsert } from "./upsertSql.js";

// Column specs. `json` columns are stored as TEXT in SQLite and cast to jsonb in PG.
const MIRROR_SPECS = [
  {
    table: "runs",
    pk: "id",
    columns: [
      "id", "capability_id", "capability_slug", "capability_name", "workflow_version",
      "runner_id", "status", "current_step", "input", "output", "error",
      "created_at", "assigned_at", "started_at", "completed_at", "updated_at",
      "parent_run_id", "attempt", "repair_count"
    ],
    json: ["input", "output"]
  },
  {
    table: "runners",
    pk: "id",
    columns: [
      "id", "name", "hostname", "platform", "version", "tags", "status",
      "current_run_id", "capacity", "active_runs", "auth_health",
      "created_at", "last_heartbeat_at"
    ],
    json: ["tags", "auth_health"]
  },
  {
    table: "capabilities",
    pk: "id",
    columns: [
      "id", "slug", "name", "description", "category", "keywords",
      "version", "enabled", "created_at", "updated_at"
    ],
    json: ["keywords"]
  },
  {
    table: "approvals",
    pk: "id",
    columns: [
      "id", "run_id", "status", "title", "description", "requested_by", "payload",
      "created_at", "resolved_at", "resolved_by", "decision", "comment"
    ],
    json: ["payload"]
  },
  {
    table: "artifacts",
    pk: "id",
    columns: [
      "id", "run_id", "name", "kind", "mime_type", "size_bytes", "path",
      "metadata", "created_at"
    ],
    json: ["metadata"]
  }
];

const EVENTS_SPEC = {
  table: "run_events",
  // seq is the SQLite rowid.
  columns: ["seq", "id", "run_id", "type", "message", "data", "created_at"],
  json: ["data"]
};

async function fullMirror(client, spec) {
  const jsonCols = new Set(spec.json || []);
  const rows = db.prepare(`SELECT ${spec.columns.join(", ")} FROM ${spec.table}`).all();
  const ids = rows.map((r) => r[spec.pk]);

  if (rows.length) {
    // Chunk to stay well under Postgres' 65535 bound-parameter limit.
    const perRow = spec.columns.length;
    const chunkSize = Math.max(1, Math.floor(60000 / perRow));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { text, values } = buildMultiUpsert(spec.table, spec.columns, jsonCols, spec.pk, chunk);
      await client.query(text, values);
    }
  }

  // Delete rows that no longer exist in SQLite (handles pruned runners, etc.).
  if (ids.length) {
    await client.query(
      `DELETE FROM ${spec.table} WHERE ${spec.pk} <> ALL($1::text[])`,
      [ids]
    );
  } else {
    await client.query(`DELETE FROM ${spec.table}`);
  }
  return rows.length;
}

async function appendEvents(client, cursorRef, limit = 5000) {
  const jsonCols = new Set(EVENTS_SPEC.json);
  const rows = db
    .prepare(
      `SELECT rowid AS seq, id, run_id, type, message, data, created_at
       FROM run_events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`
    )
    .all(cursorRef.value, limit);
  if (!rows.length) return 0;
  const { text, values } = buildMultiUpsert(
    EVENTS_SPEC.table,
    EVENTS_SPEC.columns,
    jsonCols,
    "seq",
    rows
  );
  await client.query(text, values);
  cursorRef.value = rows[rows.length - 1].seq;
  return rows.length;
}

export function createProjector({ pool, intervalMs = 500, logger = console } = {}) {
  const eventCursor = { value: 0 };
  let timer = null;
  let running = false;
  let stopped = false;
  const stats = { ticks: 0, lastError: null, mirrored: 0, events: 0 };

  async function tick() {
    if (running || stopped) return;
    running = true;
    const client = await pool.connect();
    try {
      for (const spec of MIRROR_SPECS) {
        stats.mirrored += await fullMirror(client, spec);
      }
      stats.events += await appendEvents(client, eventCursor);
      stats.ticks += 1;
      stats.lastError = null;
    } catch (err) {
      stats.lastError = err?.message || String(err);
      logger.error?.(`[projector] tick failed: ${stats.lastError}`);
    } finally {
      client.release();
      running = false;
    }
  }

  return {
    stats,
    async runOnce() {
      await tick();
      return stats;
    },
    start() {
      if (timer) return;
      // Prime immediately, then on an interval.
      tick();
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
