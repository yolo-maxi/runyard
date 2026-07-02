import path from "node:path";
import { createCliTarballBuilder, installScript as renderInstallScript } from "./clientInstall.js";
import {
  hubMenuPayload as buildHubMenuPayload,
  openApiDocument,
  renderLlmsTxt
} from "./discoveryDocs.js";

export function publicUrl(req, configuredBaseUrl = "") {
  const configured = String(configuredBaseUrl || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const protocol = req?.protocol === "https" ? "https" : "http";
  const host = safeRequestHost(req?.get?.("host"));
  return `${protocol}://${host}`;
}

function safeRequestHost(value) {
  const host = String(value || "").trim();
  const hostname = "(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|localhost)";
  const port = "(?::[0-9]{1,5})?";
  const ipv6 = "\\[[0-9A-Fa-f:.]+\\]";
  const validHost = new RegExp(`^(?:${hostname}|${ipv6})${port}$`);
  return validHost.test(host) ? host : "localhost";
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

  function hubMenuPayload(req) {
    return buildHubMenuPayload({
      baseUrl: publicUrl(req, env.baseUrl),
      capabilities: listCapabilities().map(withCapabilityLinks),
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
      res.type("text/plain").send(renderInstallScript(publicUrl(req, env.baseUrl)));
    },

    landing(req, res) {
      if (authFromRequest(req)) return res.redirect(302, "/app");
      res.sendFile(path.join(publicDir, "landing.html"));
    },

    app(_req, res) {
      res.sendFile(path.join(publicDir, "index.html"));
    },

    docs(_req, res) {
      res.sendFile(path.join(publicDir, "docs.html"));
    },

    llmsTxt(req, res) {
      res.type("text/plain").send(renderLlmsTxt(hubMenuPayload(req), publicUrl(req, env.baseUrl)));
    },

    openApi(req, res) {
      res.json(openApiDocument({ baseUrl: publicUrl(req, env.baseUrl), version: env.version }));
    },

    menu(req, res) {
      res.json(hubMenuPayload(req));
    }
  };
}
