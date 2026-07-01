// One-shot SQLite -> PostgreSQL migration for a Postgres-primary RunYard.
//
// This is NOT the projector. The projector is ongoing demo glue (SQLite stays
// source of record, mirror to Postgres). This module is a one-shot, idempotent,
// re-runnable copy that moves the existing RunYard SQLite data into a real
// Postgres so Postgres can become the primary store that Electric reads directly.
//
// Design:
//   * schema-driven: introspects the source SQLite (PRAGMA table_info) and
//     generates Postgres DDL, so it stays in sync with the real schema.
//   * fidelity: preserves primary keys, timestamps (verbatim ISO text), JSON
//     payloads (as jsonb), statuses, runner ids, and parent/lineage fields.
//   * idempotent: upserts on the primary key (safely re-runnable); optional
//     truncate for a clean reload.
//   * safe: excludes sensitive tables (secrets, access_tokens) by default and
//     never logs row values.
//
// The `pg` argument is any client exposing `query(text, values) -> { rows }`
// (node-postgres Pool/Client OR a PGlite instance — which is how the tests run a
// real-Postgres target without Docker).

// Columns that hold JSON text in SQLite and should become real jsonb in Postgres.
const JSONB_COLUMNS = {
  runs: ["input", "output", "supervisor_meta"],
  run_events: ["data"],
  runners: ["tags", "auth_health"],
  capabilities: [
    "keywords", "input_schema", "output_schema", "required_runner_tags",
    "required_skills", "required_agents", "approval_policy", "supervision", "workflow"
  ],
  capability_versions: ["snapshot"],
  approvals: ["payload"],
  artifacts: ["metadata"],
  agents: ["tools", "skill_slugs", "tags"],
  skills: ["tags"],
  knowledge_resources: ["tags"],
  schedules: ["input"],
  audit_log: ["detail"],
  workflow_endpoints: ["config"],
  run_response_endpoints: ["config"],
  _smithers_alerts: ["data"]
};

// Auth / secret material — never migrated unless explicitly opted in.
export const SENSITIVE_TABLES = new Set(["secrets", "access_tokens"]);

// Referential links validated after copy (child.col -> parent.col). Nullable
// children are only checked when the value is non-null.
export const REF_CHECKS = [
  { name: "run_events.run_id -> runs.id", table: "run_events", column: "run_id", ref: "runs", refColumn: "id", nullable: false },
  { name: "artifacts.run_id -> runs.id", table: "artifacts", column: "run_id", ref: "runs", refColumn: "id", nullable: false },
  { name: "approvals.run_id -> runs.id", table: "approvals", column: "run_id", ref: "runs", refColumn: "id", nullable: true },
  { name: "runs.parent_run_id -> runs.id", table: "runs", column: "parent_run_id", ref: "runs", refColumn: "id", nullable: true },
  { name: "run_lineage.run_id -> runs.id", table: "run_lineage", column: "run_id", ref: "runs", refColumn: "id", nullable: false },
  { name: "capability_versions.capability_id -> capabilities.id", table: "capability_versions", column: "capability_id", ref: "capabilities", refColumn: "id", nullable: false }
];

export function jsonbColumnsFor(table) {
  return new Set(JSONB_COLUMNS[table] || []);
}

export function pgTypeFor(table, column, sqliteDeclType) {
  if (jsonbColumnsFor(table).has(column)) return "jsonb";
  const t = String(sqliteDeclType || "").toUpperCase();
  if (t.includes("INT")) return "bigint";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "double precision";
  if (t.includes("BLOB")) return "bytea";
  // TEXT and everything else (incl. ISO-8601 timestamps) stay lossless text.
  return "text";
}

// Introspect the source SQLite DB. `sqlite` is a node:sqlite DatabaseSync.
export function introspectSqlite(sqlite, { includeSensitive = false, only = null } = {}) {
  const tableRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const tables = [];
  for (const { name } of tableRows) {
    if (!includeSensitive && SENSITIVE_TABLES.has(name)) continue;
    if (only && !only.includes(name)) continue;
    const cols = sqlite.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
    const columns = cols.map((c) => ({
      name: c.name,
      type: c.type,
      notnull: !!c.notnull,
      pk: c.pk // 0 = not pk, >0 = position in pk
    }));
    const pk = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    tables.push({ name, columns, pk });
  }
  return tables;
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return name;
}

export function buildCreateTable(tableInfo) {
  const defs = tableInfo.columns.map((c) => {
    const type = pgTypeFor(tableInfo.name, c.name, c.type);
    return `  ${quoteIdent(c.name)} ${type}`;
  });
  if (tableInfo.pk.length) {
    defs.push(`  PRIMARY KEY (${tableInfo.pk.map(quoteIdent).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableInfo.name)} (\n${defs.join(",\n")}\n);`;
}

// Coerce a jsonb column value: keep valid JSON text, stringify objects, else null.
function coerceJsonb(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return null; // never crash the migration on a malformed legacy blob
    }
  }
  return null;
}

function buildUpsert(tableInfo, rows) {
  const jsonCols = jsonbColumnsFor(tableInfo.name);
  const columns = tableInfo.columns.map((c) => c.name);
  const pk = tableInfo.pk;
  const tuples = [];
  const values = [];
  let p = 1;
  for (const row of rows) {
    const ph = [];
    for (const col of columns) {
      let v = row[col];
      if (v === undefined) v = null;
      if (jsonCols.has(col)) {
        v = coerceJsonb(v);
        ph.push(`$${p}::jsonb`);
      } else {
        ph.push(`$${p}`);
      }
      values.push(v);
      p += 1;
    }
    tuples.push(`(${ph.join(", ")})`);
  }
  const colList = columns.map(quoteIdent).join(", ");
  let conflict = "";
  if (pk.length) {
    const updatable = columns.filter((c) => !pk.includes(c));
    conflict = updatable.length
      ? ` ON CONFLICT (${pk.map(quoteIdent).join(", ")}) DO UPDATE SET ${updatable.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(", ")}`
      : ` ON CONFLICT (${pk.map(quoteIdent).join(", ")}) DO NOTHING`;
  }
  const text = `INSERT INTO ${quoteIdent(tableInfo.name)} (${colList}) VALUES ${tuples.join(", ")}${conflict}`;
  return { text, values };
}

function countSqlite(sqlite, table) {
  return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
}

async function countPg(pg, table) {
  const { rows } = await pg.query(`SELECT COUNT(*)::bigint AS n FROM ${quoteIdent(table)}`);
  return Number(rows[0].n);
}

// Produce a migration plan without writing anything.
export function planMigration(sqlite, opts = {}) {
  const tables = introspectSqlite(sqlite, opts);
  return {
    tables: tables.map((t) => ({
      name: t.name,
      pk: t.pk,
      columns: t.columns.length,
      jsonbColumns: [...jsonbColumnsFor(t.name)].filter((c) => t.columns.some((col) => col.name === c)),
      rows: countSqlite(sqlite, t.name),
      ddl: buildCreateTable(t)
    }))
  };
}

// Apply the migration: create tables, then copy rows (upsert on PK).
export async function applyMigration({
  sqlite,
  pg,
  includeSensitive = false,
  only = null,
  truncate = false,
  batchSize = 500,
  onProgress = null
}) {
  const tables = introspectSqlite(sqlite, { includeSensitive, only });
  const results = [];
  for (const t of tables) {
    await pg.query(buildCreateTable(t));
  }
  for (const t of tables) {
    if (truncate) await pg.query(`TRUNCATE TABLE ${quoteIdent(t.name)}`);
    const allRows = sqlite.prepare(`SELECT * FROM ${quoteIdent(t.name)}`).all();
    let copied = 0;
    for (let i = 0; i < allRows.length; i += batchSize) {
      const chunk = allRows.slice(i, i + batchSize);
      if (!chunk.length) continue;
      const { text, values } = buildUpsert(t, chunk);
      await pg.query(text, values);
      copied += chunk.length;
    }
    results.push({ table: t.name, copied });
    onProgress?.({ table: t.name, copied });
  }
  return { results };
}

// Validate the copy: row-count parity + referential orphan checks.
export async function validateMigration({ sqlite, pg, includeSensitive = false, only = null }) {
  const tables = introspectSqlite(sqlite, { includeSensitive, only });
  const present = new Set(tables.map((t) => t.name));
  const counts = [];
  for (const t of tables) {
    const s = countSqlite(sqlite, t.name);
    const p = await countPg(pg, t.name);
    counts.push({ table: t.name, sqlite: s, pg: p, ok: s === p });
  }
  const refs = [];
  for (const check of REF_CHECKS) {
    if (!present.has(check.table) || !present.has(check.ref)) continue;
    const nullClause = check.nullable ? `AND c.${quoteIdent(check.column)} IS NOT NULL` : "";
    const { rows } = await pg.query(
      `SELECT COUNT(*)::bigint AS n FROM ${quoteIdent(check.table)} c
       LEFT JOIN ${quoteIdent(check.ref)} p ON c.${quoteIdent(check.column)} = p.${quoteIdent(check.refColumn)}
       WHERE p.${quoteIdent(check.refColumn)} IS NULL
       AND c.${quoteIdent(check.column)} IS NOT NULL ${nullClause}`
    );
    refs.push({ name: check.name, orphans: Number(rows[0].n) });
  }
  const ok = counts.every((c) => c.ok) && refs.every((r) => r.orphans === 0);
  return { ok, counts, refs };
}
