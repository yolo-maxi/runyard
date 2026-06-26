import {
  claimNextRun,
  heartbeatRunner,
  listRunners,
  registerRunner,
  runnerPoolStats
} from "../db.js";
import { asyncHandler } from "../http.js";

export function registerRunnerRoutes(app, { requireAuth, requireScopes }) {
  app.post("/api/runners/register", requireAuth, requireScopes("runner"), (req, res) => {
    const runner = registerRunner(req.body, req.token.id);
    res.json({ runner });
  });

  app.get("/api/runners", requireAuth, (_req, res) => {
    res.json({ runners: listRunners(), pool: runnerPoolStats() });
  });

  app.post("/api/runners/:id/heartbeat", requireAuth, requireScopes("runner"), (req, res) => {
    res.json({ runner: heartbeatRunner(req.params.id, req.body) });
  });

  app.get(
    "/api/runners/:id/next-run",
    requireAuth,
    requireScopes("runner"),
    asyncHandler(async (req, res) => {
      res.json(claimNextRun(req.params.id) || {});
    })
  );
}
