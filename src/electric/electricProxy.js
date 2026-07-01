// Backend auth proxy for ElectricSQL shape requests.
//
// Production Electric deployments must never be exposed directly to browsers.
// This proxy sits behind RunYard's existing session/token auth (requireAuth) and:
//   * restricts shapes to a fixed allowlist of mirror tables (no arbitrary SQL),
//   * scopes the run_events trace stream to a single validated run_id,
//   * forwards only the Electric protocol params (offset/handle/live/cursor/replica),
//   * relays Electric's electric-* response headers so the client can page + go live.
//
// The Electric sync service itself is bound to localhost and never routed publicly.

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

// Allowlisted shapes. `where` is server-defined; clients cannot supply arbitrary
// filters. run_events additionally requires a validated run_id scope.
const SHAPES = {
  runs: { table: "runs" },
  run_events: { table: "run_events", requireRunId: true },
  runners: { table: "runners" },
  capabilities: { table: "capabilities" },
  approvals: { table: "approvals" },
  artifacts: { table: "artifacts" }
};

const PASSTHROUGH_PARAMS = ["offset", "handle", "live", "cursor", "replica", "columns"];
const RELAY_HEADER_PREFIX = "electric-";

export function registerElectricProxy(app, {
  requireAuth,
  electricUrl = process.env.ELECTRIC_URL || "http://127.0.0.1:3316",
  projector = null,
  logger = console
} = {}) {
  const base = electricUrl.replace(/\/$/, "");

  app.get("/api/electric/status", requireAuth, async (req, res) => {
    let electric = "unknown";
    try {
      const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(3000) });
      electric = r.ok ? (await r.json())?.status || "ok" : `http_${r.status}`;
    } catch (err) {
      electric = `unreachable: ${err?.message || err}`;
    }
    res.json({
      electric,
      projector: projector ? projector.stats : null,
      shapes: Object.keys(SHAPES)
    });
  });

  app.get("/api/electric/v1/shape", requireAuth, async (req, res) => {
    const shapeName = String(req.query.table || "");
    const shape = SHAPES[shapeName];
    if (!shape) {
      return res.status(400).json({ error: "unknown shape", allowed: Object.keys(SHAPES) });
    }

    const upstream = new URL("/v1/shape", `${base}/`);
    upstream.searchParams.set("table", shape.table);

    if (shape.requireRunId) {
      const runId = String(req.query.run_id || "");
      if (!SAFE_ID.test(runId)) {
        return res.status(400).json({ error: "valid run_id required for run_events shape" });
      }
      upstream.searchParams.set("where", `run_id = '${runId}'`);
    }

    for (const key of PASSTHROUGH_PARAMS) {
      const val = req.query[key];
      if (val !== undefined && val !== null && val !== "") {
        upstream.searchParams.set(key, String(val));
      }
    }

    // Abort the upstream long-poll if the client disconnects.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on("close", onClose);

    try {
      const upstreamRes = await fetch(upstream, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      const body = await upstreamRes.arrayBuffer();
      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, name) => {
        if (name.startsWith(RELAY_HEADER_PREFIX) || name === "content-type") {
          res.set(name, value);
        }
      });
      res.set("cache-control", "no-store");
      res.send(Buffer.from(body));
    } catch (err) {
      if (controller.signal.aborted) {
        if (!res.headersSent) res.status(499).end();
        return;
      }
      logger.error?.(`[electric-proxy] upstream error: ${err?.message || err}`);
      if (!res.headersSent) res.status(502).json({ error: "electric upstream unreachable" });
    } finally {
      req.off("close", onClose);
    }
  });
}
