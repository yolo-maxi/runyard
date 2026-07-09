import express from "express";

const ARTIFACT_UPLOAD_PATH = /^\/api\/runs\/[^/]+\/artifacts\/?$/;
// Metering-gateway inference calls carry full model contexts, which routinely
// exceed the standard API body limit.
const GATEWAY_PATH = /^\/api\/gateway\//;

export function jsonBodyMiddleware({
  json = express.json,
  standardLimit = "1mb",
  artifactLimit = "25mb"
} = {}) {
  const standardJson = json({ limit: standardLimit });
  const artifactJson = json({ limit: artifactLimit });

  return (req, res, next) => {
    const parser = req.method === "POST" && (ARTIFACT_UPLOAD_PATH.test(req.path) || GATEWAY_PATH.test(req.path))
      ? artifactJson
      : standardJson;
    return parser(req, res, next);
  };
}

export function securityHeaders({ baseUrl = "" } = {}) {
  return (req, res, next) => {
    const appSurface = req.path === "/app";
    const frameAncestors = appSurface ? "'self' https://web.telegram.org https://*.telegram.org" : "'none'";
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    if (!appSurface) res.setHeader("x-frame-options", "DENY");
    res.setHeader(
      "content-security-policy",
      `default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'; object-src 'none'`
    );
    if (String(baseUrl || "").startsWith("https://")) {
      res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

export function createRateLimiter({ now = Date.now, sweepIntervalMs = 60_000 } = {}) {
  const buckets = new Map();
  const sweep = setInterval(() => sweepExpiredBuckets(buckets, now()), sweepIntervalMs);
  sweep.unref?.();

  return {
    middleware: ({ bucket, max, windowMs }) => rateLimit({ bucket, max, windowMs }, { buckets, now }),
    sweep,
    buckets,
    sweepExpired: () => sweepExpiredBuckets(buckets, now())
  };
}

export function expressErrorHandler({ log = console.error } = {}) {
  return (error, _req, res, _next) => {
    log(error);
    // Respect known client errors but never leak parser internals or stacks.
    const status = error.status || error.statusCode;
    if (status === 413) return res.status(413).json({ error: "payload too large" });
    if (status === 400 && error.type) return res.status(400).json({ error: "invalid request body" });
    res.status(500).json({ error: "internal server error" });
  };
}

function rateLimit({ bucket, max, windowMs }, { buckets, now }) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const nowMs = now();
    const entry = buckets.get(key);
    if (!entry || nowMs > entry.reset) {
      buckets.set(key, { count: 1, reset: nowMs + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.setHeader("retry-after", Math.ceil((entry.reset - nowMs) / 1000));
      return res.status(429).json({ error: "too many requests" });
    }
    entry.count += 1;
    next();
  };
}

function sweepExpiredBuckets(buckets, nowMs) {
  for (const [key, entry] of buckets) if (nowMs > entry.reset) buckets.delete(key);
}
