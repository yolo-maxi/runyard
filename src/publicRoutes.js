import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { createCliTarballBuilder, installScript as renderInstallScript } from "./clientInstall.js";
import {
  hubMenuPayload as buildHubMenuPayload,
  openApiDocument,
  renderLlmsTxt
} from "./discoveryDocs.js";

export function publicUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

export function healthPayload(startedAt, nowMs = Date.now()) {
  return { status: "ok", uptimeSeconds: Math.floor((nowMs - startedAt) / 1000) };
}

export function apiVersionPayload(env = {}) {
  return { name: "runyard", version: env.version, instanceName: env.instanceName };
}

export function versionPayload(info = {}) {
  return { version: info.version, gitTag: info.gitTag, gitCommit: info.gitCommit };
}

export function createPublicHandlers({
  authFromRequest,
  dashboardStats,
  env,
  getVersionInfo,
  listCapabilities,
  runnerPoolStats,
  startedAt = Date.now(),
  withCapabilityLinks
} = {}) {
  const publicDir = path.join(env.root, "public");
  const buildCliTarball = createCliTarballBuilder({ root: env.root, dataDir: env.dataDir });

  // The docs site is a static Fumadocs export committed at docs-site/out
  // (built with `pnpm build:docs`; base path /docs). Its pages carry Next.js
  // inline bootstrap scripts, so responses under /docs relax script-src to
  // 'unsafe-inline' — the content is repo-authored, same-origin static HTML.
  const docsSiteDir = path.join(env.root, "docs-site", "out");
  const docsSiteReady = existsSync(path.join(docsSiteDir, "index.html"));
  const docsSiteStatic = express.static(docsSiteDir);
  const docsCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

  function hubMenuPayload(req) {
    return buildHubMenuPayload({
      baseUrl: publicUrl(req),
      workflows: listCapabilities().map(withCapabilityLinks),
      pool: runnerPoolStats()
    });
  }

  return {
    publicDir,

    healthz(_req, res) {
      res.json(healthPayload(startedAt));
    },

    readyz(_req, res) {
      try {
        dashboardStats();
        res.json({ status: "ready" });
      } catch {
        res.status(503).json({ status: "unavailable" });
      }
    },

    apiVersion(_req, res) {
      res.json(apiVersionPayload(env));
    },

    version(_req, res) {
      res.json(versionPayload(getVersionInfo()));
    },

    cliTarball(_req, res) {
      try {
        res.type("application/gzip").sendFile(buildCliTarball());
      } catch {
        res.status(500).json({ error: "could not build client bundle" });
      }
    },

    installScript(req, res) {
      res.type("text/plain").send(renderInstallScript(publicUrl(req)));
    },

    landing(req, res) {
      if (authFromRequest(req)) return res.redirect(302, "/app");
      res.sendFile(path.join(publicDir, "landing.html"));
    },

    app(_req, res) {
      res.sendFile(path.join(publicDir, "index.html"));
    },

    // Mounted with app.use("/docs", ...): serves the static docs site, falls
    // back to the legacy single-page docs.html when no build is present
    // (fresh clone before `pnpm build:docs`), and answers unknown docs paths
    // with the site's own 404 page.
    docsSite(req, res, next) {
      if (!docsSiteReady) return res.sendFile(path.join(publicDir, "docs.html"));
      res.setHeader("Content-Security-Policy", docsCsp);
      docsSiteStatic(req, res, (error) => {
        if (error) return next(error);
        const notFound = path.join(docsSiteDir, "404.html");
        if (existsSync(notFound)) return res.status(404).sendFile(notFound);
        next();
      });
    },

    // Unauthenticated discovery copy is static/generic: the live capability
    // catalog stays behind auth on /api/menu (see renderLlmsTxt).
    llmsTxt(req, res) {
      res.type("text/plain").send(renderLlmsTxt(publicUrl(req)));
    },

    openApi(req, res) {
      res.json(openApiDocument({ baseUrl: publicUrl(req), version: env.version }));
    },

    menu(req, res) {
      res.json(hubMenuPayload(req));
    }
  };
}
