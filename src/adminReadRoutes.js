import { boundedLimit } from "./httpQuery.js";

export function createAdminReadHandlers({
  listAlerts,
  listAudit
} = {}) {
  return {
    listAudit(req, res) {
      res.json({ audit: listAudit({ limit: boundedLimit(req.query.limit, 100, 500) }) });
    },

    listAlerts(req, res) {
      res.json({
        alerts: listAlerts({
          kind: req.query.kind ? String(req.query.kind) : "",
          limit: boundedLimit(req.query.limit, 50, 500)
        })
      });
    }
  };
}
