// RunYard Electric demo entrypoint.
//
// Reuses the full production RunYard Express app (all existing routes untouched)
// and layers the Electric read path on top:
//   * an auth-proxied Electric shape endpoint (/api/electric/v1/shape),
//   * the SQLite -> Postgres projector,
//   * optional deterministic demo traffic (RUNYARD_DEMO_TRAFFIC=1).
//
// It intentionally does NOT start the production background runtime (reapers,
// schedulers): this is a read/sync demo, and the reaper would otherwise reap the
// synthetic demo runs. Runs isolated on its own port + data dir + Postgres.
import { app } from "./server.js";
import * as db from "./db.js";
import { env } from "./env.js";
import { createAuthMiddleware } from "./authMiddleware.js";
import { authenticateTelegramWebAppSession, telegramSessionCanAccess } from "./telegramWebAppAuth.js";
import { createPgPool } from "./electric/pgPool.js";
import { createProjector } from "./electric/projector.js";
import { registerElectricProxy } from "./electric/electricProxy.js";
import { startDemoTraffic } from "./electric/demoTraffic.js";

const { requireAuth } = createAuthMiddleware({
  authenticateTelegramWebAppSession,
  authenticateToken: db.authenticateToken,
  env,
  getRun: db.getRun,
  runOwnerTokenId: db.runOwnerTokenId,
  telegramSessionCanAccess
});

const pool = createPgPool();
const projector = createProjector({
  pool,
  intervalMs: Number(process.env.ELECTRIC_PROJECTOR_INTERVAL_MS || 500)
});

registerElectricProxy(app, {
  requireAuth,
  projector,
  electricUrl: process.env.ELECTRIC_URL || "http://127.0.0.1:3316"
});

projector.start();

let traffic = null;
if (process.env.RUNYARD_DEMO_TRAFFIC === "1") {
  traffic = startDemoTraffic({
    concurrency: Number(process.env.RUNYARD_DEMO_TRAFFIC_CONCURRENCY || 2)
  });
}

const server = app.listen(env.port, env.host, () => {
  console.log(`RunYard Electric demo listening on http://${env.host}:${env.port}`);
  console.log(`  Electric upstream: ${process.env.ELECTRIC_URL || "http://127.0.0.1:3316"}`);
  console.log(`  Demo traffic: ${traffic ? "on" : "off"}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down demo...`);
  projector.stop();
  if (traffic) traffic.stop();
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
