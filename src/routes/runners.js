import {
  claimNextRun,
  heartbeatRunner,
  listRunners,
  registerRunner,
  runnerOwnerTokenId,
  runnerPoolStats
} from "../db.js";
import { asyncHandler } from "../http.js";

export function registerRunnerRoutes(app, { requireAuth, requireScopes }) {
  function requireRunnerOwner(req, res, next) {
    const scopes = req.token?.scopes || [];
    if (scopes.includes("admin")) return next();
    const ownerTokenId = runnerOwnerTokenId(req.params.id);
    if (!ownerTokenId) return res.status(404).json({ error: "runner not found" });
    if (ownerTokenId === req.token.id) return next();
    return res.status(403).json({ error: "runner not owned by this token" });
  }

  app.post("/api/runners/register", requireAuth, requireScopes("runner"), (req, res) => {
    const runner = registerRunner(req.body, req.token.id);
    res.json({ runner });
  });

  app.get("/api/runners", requireAuth, (_req, res) => {
    res.json({ runners: listRunners(), pool: runnerPoolStats() });
  });

  app.post("/api/runners/:id/heartbeat", requireAuth, requireScopes("runner"), requireRunnerOwner, (req, res) => {
    res.json({ runner: heartbeatRunner(req.params.id, req.body) });
  });

  app.get(
    "/api/runners/:id/next-run",
    requireAuth,
    requireScopes("runner"),
    requireRunnerOwner,
    asyncHandler(async (req, res) => {
      res.json(claimNextRun(req.params.id) || {});
    })
  );
}
