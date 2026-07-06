import express from "express";
import { createRateLimiter, expressErrorHandler, jsonBodyMiddleware, securityHeaders } from "./httpMiddleware.js";
import * as db from "./db.js";
import { env } from "./env.js";
import { getVersionInfo } from "./version.js";
import { createUpdateChecker } from "./updateCheck.js";
import { parseTelegramApprovalCallback } from "./telegramApprovals.js";
import { startServerRuntime } from "./serverRuntime.js";
import { registerServerRoutes } from "./serverRoutes.js";
import { createServerComposition } from "./serverComposition.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.trustProxy);

// Passive update checker (the CHECK half of CHECK != APPLY). Outbound-only,
// read-only GitHub Releases poll with a ~1h cache; degrades to "unknown" on any
// failure and never installs anything. Swappable in tests via
// setUpdateCheckerForTest so the suite never makes a live network call.
let updateChecker = createUpdateChecker({
  repo: env.githubRepo,
  currentVersion: getVersionInfo().version,
  ttlMs: env.updateCheckIntervalMs
});
export function setUpdateCheckerForTest(checker) {
  updateChecker = checker;
}

app.use(jsonBodyMiddleware());
app.use(express.urlencoded({ extended: false }));

const startedAt = Date.now();
const rateLimiter = createRateLimiter();
const rateLimit = rateLimiter.middleware;

const composition = createServerComposition({
  db,
  env,
  getUpdateChecker: () => updateChecker,
  getVersionInfo,
  startedAt
});

app.use(securityHeaders({ baseUrl: env.baseUrl }));

// General API rate limit (defense against scraping/abuse); login has a stricter bucket below.
app.use("/api", rateLimit({ bucket: "api", max: 1200, windowMs: 60_000 }));

registerServerRoutes(app, {
  ...composition.routes,
  rateLimit,
});

function fireDueSchedules(nowIso) {
  return composition.fireDueSchedules(nowIso);
}
const notifyTelegram = composition.notifyTelegram;
const telegramApprovalTarget = composition.telegramApprovalTarget;

app.use(expressErrorHandler());

if (process.argv[1]?.endsWith("server.js")) {
  startServerRuntime({
    app,
    env,
    fireDueSchedules,
    pruneDeadRunners: composition.pruneDeadRunners,
    reapStuckRunsWithRetrospectives: composition.reapStuckRunsWithRetrospectives,
    reconcileRunnerActiveRuns: composition.reconcileRunnerActiveRuns,
    sweepSupersededApprovals: composition.sweepSupersededApprovals,
    sweepTimedApprovals: composition.sweepTimedApprovals,
    updateChecker
  });
}

export {
  app,
  fireDueSchedules,
  notifyTelegram,
  parseTelegramApprovalCallback,
  telegramApprovalTarget
};
