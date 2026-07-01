#!/usr/bin/env node
// One-shot SQLite -> PostgreSQL migration CLI for a Postgres-primary RunYard.
//
// Usage:
//   node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --plan
//   node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --apply
//   node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --validate
//
// Options:
//   --plan (default)   introspect + show tables/row counts/DDL; writes nothing
//   --apply            create schema + copy rows (idempotent upsert on PK)
//   --validate         compare row counts + referential links
//   --emit-ddl         print the generated Postgres DDL and exit
//   --truncate         with --apply, TRUNCATE each target table before copy
//   --source <path>    source SQLite file (default $RUNYARD_HUB_DB / $SMITHERS_HUB_DB)
//   --database-url <u> target Postgres (default $MIGRATION_DATABASE_URL / $DATABASE_URL)
//   --tables a,b,c     restrict to these tables
//   --include-sensitive  also migrate secrets/access_tokens (OFF by default)
//
// Safety: opens SQLite read-only, never prints row values or secrets, and the
// default table set excludes secrets + access_tokens.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  planMigration,
  applyMigration,
  validateMigration,
  introspectSqlite,
  buildCreateTable
} from "../src/electric/migrate.js";

function parseArgs(argv) {
  const args = { mode: "plan" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--plan") args.mode = "plan";
    else if (a === "--apply") args.mode = "apply";
    else if (a === "--validate") args.mode = "validate";
    else if (a === "--emit-ddl") args.emitDdl = true;
    else if (a === "--truncate") args.truncate = true;
    else if (a === "--include-sensitive") args.includeSensitive = true;
    else if (a === "--source") args.source = argv[++i];
    else if (a === "--database-url") args.databaseUrl = argv[++i];
    else if (a === "--tables") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const source = args.source || process.env.RUNYARD_HUB_DB || process.env.SMITHERS_HUB_DB;
  if (!source) die("no source SQLite path (--source or $RUNYARD_HUB_DB)");

  const sqlite = new DatabaseSync(source, { readOnly: true });

  if (args.emitDdl) {
    const tables = introspectSqlite(sqlite, { includeSensitive: args.includeSensitive, only: args.only });
    for (const t of tables) console.log(buildCreateTable(t) + "\n");
    return;
  }

  if (args.mode === "plan") {
    const plan = planMigration(sqlite, { includeSensitive: args.includeSensitive, only: args.only });
    console.log(`Migration PLAN (source: ${source}) — no writes\n`);
    let total = 0;
    for (const t of plan.tables) {
      total += t.rows;
      const j = t.jsonbColumns.length ? ` jsonb[${t.jsonbColumns.join(",")}]` : "";
      console.log(`  ${t.name.padEnd(28)} ${String(t.rows).padStart(7)} rows  pk(${t.pk.join(",") || "-"})${j}`);
    }
    console.log(`\n  ${plan.tables.length} tables, ${total} rows total`);
    console.log("\nBackup note: take a Postgres backup (pg_dump) before --apply. Source SQLite is opened read-only and never modified.");
    return;
  }

  const target = args.databaseUrl || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!target) die("no target Postgres (--database-url or $MIGRATION_DATABASE_URL/$DATABASE_URL)");
  const pool = new pg.Pool({ connectionString: target, max: 4 });

  try {
    if (args.mode === "apply") {
      console.log(`Migration APPLY (source: ${source} -> Postgres)${args.truncate ? " [truncate]" : " [idempotent upsert]"}\n`);
      const { results } = await applyMigration({
        sqlite,
        pg: pool,
        includeSensitive: args.includeSensitive,
        only: args.only,
        truncate: args.truncate,
        onProgress: ({ table, copied }) => console.log(`  copied ${String(copied).padStart(7)}  ${table}`)
      });
      const total = results.reduce((n, r) => n + r.copied, 0);
      console.log(`\n  done: ${results.length} tables, ${total} rows copied`);
      console.log("  run --validate to confirm counts + referential integrity");
    } else if (args.mode === "validate") {
      const report = await validateMigration({
        sqlite,
        pg: pool,
        includeSensitive: args.includeSensitive,
        only: args.only
      });
      console.log("Migration VALIDATE\n\n  row counts (sqlite vs pg):");
      for (const c of report.counts) {
        console.log(`  ${c.ok ? "ok " : "MISMATCH "} ${c.table.padEnd(28)} sqlite=${c.sqlite} pg=${c.pg}`);
      }
      console.log("\n  referential checks:");
      for (const r of report.refs) {
        console.log(`  ${r.orphans === 0 ? "ok " : "ORPHANS "} ${r.name}  orphans=${r.orphans}`);
      }
      console.log(`\n  overall: ${report.ok ? "PASS" : "FAIL"}`);
      if (!report.ok) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => die(e?.stack || String(e)));
