import express from "express";
import { API_SURFACE } from "./apiSurface.js";
import { asyncHandler } from "./http.js";
import { registerRunnerRoutes } from "./routes/runners.js";

// Routes are registered by interpreting the API surface registry
// (src/apiSurface.js) in order. The registry — not this file — is where an
// endpoint's method, path, auth, scopes, OpenAPI summary, and MCP mapping
// live, so adding a route forces those decisions in one place and keeps the
// discovery surfaces in sync. tests/api-surface.test.js asserts that what
// this function registers matches the registry exactly.

function resolveHandler(deps, path) {
  let value = deps;
  for (const segment of path.split(".")) {
    value = value?.[segment];
    if (value === undefined) throw new Error(`API surface handler ${path} is not provided`);
  }
  return value;
}

export function registerServerRoutes(app, deps) {
  const { rateLimit, requireAuth, requireRunOwnerOrAdmin, requireScopes, secretHandlers } = deps;
  let runnerRoutesRegistered = false;

  for (const operation of API_SURFACE) {
    if (operation.external === "runners") {
      // routes/runners.js registers its own handlers; keep its position in
      // the registration order and register the whole group once.
      if (!runnerRoutesRegistered) {
        registerRunnerRoutes(app, { requireAuth, requireScopes });
        runnerRoutesRegistered = true;
      }
      continue;
    }

    if (operation.method === "static") {
      app.use(operation.path, express.static(resolveHandler(deps, operation.handler)));
      continue;
    }

    if (operation.method === "use") {
      app.use(operation.path, resolveHandler(deps, operation.handler));
      continue;
    }

    const chain = [];
    if (operation.auth) chain.push(requireAuth);
    if (operation.scopes?.length) chain.push(requireScopes(...operation.scopes));
    if (operation.runnerOwner) chain.push(requireRunOwnerOrAdmin);
    if (operation.secretsGate) chain.push(secretHandlers.requireSecretsEnabled);
    if (operation.rateLimit) chain.push(rateLimit(operation.rateLimit));
    const handler = resolveHandler(deps, operation.handler);
    chain.push(operation.wrap === "async" ? asyncHandler(handler) : handler);

    app[operation.method](operation.path, ...chain);
  }
}
