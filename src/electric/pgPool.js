// Postgres connection pool for the Electric demo mirror.
// The mirror DB is a demo-only projection target; SQLite stays the source of truth.
import pg from "pg";

const { Pool } = pg;

export function electricDatabaseUrl(processEnv = process.env) {
  return (
    processEnv.ELECTRIC_MIRROR_DATABASE_URL ||
    processEnv.DATABASE_URL ||
    "postgresql://runyard:runyard_electric_dev@127.0.0.1:54329/runyard"
  );
}

export function createPgPool(processEnv = process.env) {
  return new Pool({
    connectionString: electricDatabaseUrl(processEnv),
    max: Number(processEnv.ELECTRIC_MIRROR_POOL_MAX || 4),
    idleTimeoutMillis: 30_000
  });
}
