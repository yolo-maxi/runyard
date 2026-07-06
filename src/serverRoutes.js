import express from "express";
import { asyncHandler } from "./http.js";
import { registerRunnerRoutes } from "./routes/runners.js";

export function registerServerRoutes(app, {
  adminReadHandlers,
  approvalHandlers,
  artifactHandlers,
  authHandlers,
  capabilityHandlers,
  catalogHandlers,
  hookProfileHandlers,
  operatorReadHandlers,
  publicHandlers,
  rateLimit,
  requireAuth,
  requireRunOwnerOrAdmin,
  requireScopes,
  runDraftHandlers,
  runLifecycleHandlers,
  runPromotionHandlers,
  runReadHandlers,
  runRerunHandlers,
  scheduleHandlers,
  secretHandlers,
  supportChatHandlers,
  tokenHandlers,
  updateHandlers,
  workflowBundleHandlers,
  workflowPackageHandlers,
  workflowEndpointHandlers
}) {
  app.get("/healthz", publicHandlers.healthz);
  app.get("/readyz", publicHandlers.readyz);
  app.get("/api/version", publicHandlers.apiVersion);
  app.get("/version", publicHandlers.version);

  app.get("/cli.tgz", publicHandlers.cliTarball);
  app.get("/install.sh", publicHandlers.installScript);

  app.get("/", publicHandlers.landing);
  app.get("/app", publicHandlers.app);
  app.get("/docs", publicHandlers.docs);
  app.get("/docs/quickstart", publicHandlers.docs);
  app.use("/public", express.static(publicHandlers.publicDir));

  app.get("/llms.txt", publicHandlers.llmsTxt);
  app.get("/openapi.json", publicHandlers.openApi);
  app.get("/api/menu", requireAuth, requireScopes("api", "mcp"), publicHandlers.menu);

  app.get("/api/setup", authHandlers.setup);
  app.post("/api/auth/token-login", rateLimit({ bucket: "login", max: 10, windowMs: 60_000 }), authHandlers.tokenLogin);
  app.post("/api/auth/telegram-webapp", rateLimit({ bucket: "telegram-webapp-login", max: 30, windowMs: 60_000 }), authHandlers.telegramWebAppLogin);
  app.post("/api/auth/logout", authHandlers.logout);
  app.get("/api/me", requireAuth, authHandlers.me);

  app.get("/api/tokens", requireAuth, requireScopes("admin"), tokenHandlers.listTokens);
  app.post("/api/tokens", requireAuth, requireScopes("admin"), tokenHandlers.createToken);
  app.delete("/api/tokens/:id", requireAuth, requireScopes("admin"), tokenHandlers.revokeToken);

  app.get("/api/audit", requireAuth, requireScopes("admin"), adminReadHandlers.listAudit);
  app.get("/api/alerts", requireAuth, requireScopes("admin"), adminReadHandlers.listAlerts);

  app.get("/api/update-status", requireAuth, requireScopes("admin"), asyncHandler(updateHandlers.status));
  app.post("/api/update/apply", requireAuth, requireScopes("admin"), updateHandlers.apply);

  app.get("/api/secrets", requireAuth, requireScopes("admin"), secretHandlers.requireSecretsEnabled, secretHandlers.listSecrets);
  app.put("/api/secrets/:key", requireAuth, requireScopes("admin"), secretHandlers.requireSecretsEnabled, secretHandlers.upsertSecret);
  app.delete("/api/secrets/:key", requireAuth, requireScopes("admin"), secretHandlers.requireSecretsEnabled, secretHandlers.deleteSecret);

  app.get("/api/workflow-endpoints", requireAuth, requireScopes("admin"), workflowEndpointHandlers.listWorkflowEndpoints);
  app.post("/api/workflow-endpoints", requireAuth, requireScopes("admin"), workflowEndpointHandlers.upsertWorkflowEndpoint);
  app.get("/api/workflow-endpoints/:endpointSlug", requireAuth, requireScopes("admin"), workflowEndpointHandlers.getWorkflowEndpoint);
  app.post("/api/workflow-endpoints/:endpointSlug", asyncHandler(workflowEndpointHandlers.submitWorkflowEndpoint));

  app.get("/api/workflow-bundles", requireAuth, workflowBundleHandlers.listWorkflowBundles);
  app.post("/api/workflow-bundles", requireAuth, requireScopes("admin"), workflowBundleHandlers.publishWorkflowBundle);
  app.get("/api/workflow-bundles/:id", requireAuth, workflowBundleHandlers.getWorkflowBundle);

  app.get("/api/workflow-packages/workflows/:id/export", requireAuth, requireScopes("admin"), workflowPackageHandlers.exportWorkflowPackage);
  app.get("/api/workflow-packages/capabilities/:id/export", requireAuth, requireScopes("admin"), workflowPackageHandlers.exportWorkflowPackage);
  app.post("/api/workflow-packages/validate", requireAuth, requireScopes("admin"), workflowPackageHandlers.validateWorkflowPackage);
  app.post("/api/workflow-packages/preview", requireAuth, requireScopes("admin"), workflowPackageHandlers.previewWorkflowPackageImport);
  app.post("/api/workflow-packages/import", requireAuth, requireScopes("admin"), workflowPackageHandlers.importWorkflowPackage);

  app.get("/api/dashboard", requireAuth, operatorReadHandlers.dashboard);
  app.get("/api/repo-options", requireAuth, operatorReadHandlers.repoOptions);

  // Post-run hook profiles: discovery is authenticated (non-admins see only
  // enabled profiles in a caller-safe shape); every mutation and readiness
  // probe is admin-only, like workflow endpoints and secrets.
  app.get("/api/hooks", requireAuth, hookProfileHandlers.listHookProfiles);
  app.get("/api/hooks/:slug", requireAuth, hookProfileHandlers.getHookProfile);
  app.post("/api/hooks", requireAuth, requireScopes("admin"), hookProfileHandlers.upsertHookProfile);
  app.patch("/api/hooks/:slug", requireAuth, requireScopes("admin"), hookProfileHandlers.upsertHookProfile);
  app.post("/api/hooks/:slug/validate", requireAuth, requireScopes("admin"), hookProfileHandlers.validateHookProfile);

  app.get("/api/workflows", requireAuth, capabilityHandlers.listWorkflows);
  app.post("/api/workflows", requireAuth, requireScopes("admin"), capabilityHandlers.createWorkflow);
  app.get("/api/workflows/:id", requireAuth, capabilityHandlers.getWorkflow);
  app.get("/api/workflows/:name/versions", requireAuth, capabilityHandlers.getWorkflowVersions);
  app.get("/api/workflows/:id/source", requireAuth, capabilityHandlers.getWorkflowSource);
  app.patch("/api/workflows/:id", requireAuth, requireScopes("admin"), capabilityHandlers.updateWorkflow);
  app.delete("/api/workflows/:id", requireAuth, requireScopes("admin"), capabilityHandlers.deleteWorkflow);
  app.post("/api/workflows/:id/run", requireAuth, requireScopes("api", "mcp"), asyncHandler(capabilityHandlers.runWorkflow));
  app.post("/api/workflows/:id/preflight", requireAuth, requireScopes("api", "mcp"), capabilityHandlers.preflightWorkflow);

  app.get("/api/capabilities", requireAuth, capabilityHandlers.listCapabilities);
  app.post("/api/capabilities", requireAuth, requireScopes("admin"), capabilityHandlers.createCapability);
  app.get("/api/capabilities/:id", requireAuth, capabilityHandlers.getCapability);
  app.get("/api/capabilities/:name/versions", requireAuth, capabilityHandlers.getCapabilityVersions);
  app.get("/api/capabilities/:id/source", requireAuth, capabilityHandlers.getCapabilitySource);
  app.patch("/api/capabilities/:id", requireAuth, requireScopes("admin"), capabilityHandlers.updateCapability);
  app.post("/api/capabilities/:id/run", requireAuth, requireScopes("api", "mcp"), asyncHandler(capabilityHandlers.runCapability));
  app.post("/api/capabilities/:id/preflight", requireAuth, requireScopes("api", "mcp"), capabilityHandlers.preflightCapability);

  // Run-creation negotiation drafts: create/validate -> patch answers -> submit
  // only when preflight is ready. Reads are any-auth (like /api/runs); every
  // mutation needs the same api/mcp scopes as starting a run.
  app.get("/api/run-drafts", requireAuth, runDraftHandlers.listRunDrafts);
  app.post("/api/run-drafts", requireAuth, requireScopes("api", "mcp"), runDraftHandlers.createRunDraft);
  app.get("/api/run-drafts/:id", requireAuth, runDraftHandlers.getRunDraft);
  app.patch("/api/run-drafts/:id", requireAuth, requireScopes("api", "mcp"), runDraftHandlers.patchRunDraft);
  app.post("/api/run-drafts/:id/submit", requireAuth, requireScopes("api", "mcp"), asyncHandler(runDraftHandlers.submitRunDraft));
  app.post("/api/run-drafts/:id/discard", requireAuth, requireScopes("api", "mcp"), runDraftHandlers.discardRunDraft);

  app.get("/api/schedules", requireAuth, scheduleHandlers.listSchedules);
  app.get("/api/schedules/preview", requireAuth, scheduleHandlers.previewSchedule);
  app.get("/api/schedules/:id", requireAuth, scheduleHandlers.getSchedule);
  app.post("/api/schedules", requireAuth, requireScopes("admin"), scheduleHandlers.createSchedule);
  app.patch("/api/schedules/:id", requireAuth, requireScopes("admin"), scheduleHandlers.updateSchedule);
  app.post("/api/schedules/:id/enable", requireAuth, requireScopes("admin"), scheduleHandlers.enableSchedule);
  app.post("/api/schedules/:id/disable", requireAuth, requireScopes("admin"), scheduleHandlers.disableSchedule);
  app.delete("/api/schedules/:id", requireAuth, requireScopes("admin"), scheduleHandlers.deleteSchedule);
  app.post(
    "/api/schedules/:id/run-now",
    requireAuth,
    requireScopes("api", "mcp", "admin"),
    rateLimit({ bucket: "schedule-run-now", max: 60, windowMs: 60_000 }),
    asyncHandler(scheduleHandlers.runScheduleNowRoute)
  );

  app.get("/api/agents", requireAuth, catalogHandlers.agents.list);
  app.post("/api/agents", requireAuth, requireScopes("admin"), catalogHandlers.agents.create);
  app.patch("/api/agents/:slug", requireAuth, requireScopes("admin"), catalogHandlers.agents.update);

  app.get("/api/skills", requireAuth, catalogHandlers.skills.list);
  app.post("/api/skills", requireAuth, requireScopes("admin"), catalogHandlers.skills.create);
  app.patch("/api/skills/:slug", requireAuth, requireScopes("admin"), catalogHandlers.skills.update);

  app.get("/api/knowledge", requireAuth, catalogHandlers.knowledge.list);
  app.post("/api/knowledge", requireAuth, requireScopes("admin"), catalogHandlers.knowledge.create);
  app.patch("/api/knowledge/:slug", requireAuth, requireScopes("admin"), catalogHandlers.knowledge.update);

  app.get("/api/runs", requireAuth, runReadHandlers.listRuns);
  app.get("/api/runs/:id", requireAuth, runReadHandlers.getRun);
  app.get("/api/runs/:id/events", requireAuth, runReadHandlers.listRunEvents);
  app.get("/api/runs/:id/events/stream", requireAuth, runReadHandlers.streamRunEvents);
  app.get("/api/runs/:id/log-summary", requireAuth, runReadHandlers.getRunLogSummary);
  app.get("/api/runs/:id/diagnostics", requireAuth, runReadHandlers.getRunDiagnostics);
  app.get("/api/runs/:id/logs", requireAuth, runReadHandlers.getRunLogs);
  app.get("/api/runs/:id/timeline", requireAuth, runReadHandlers.getRunTimeline);
  app.post("/api/runs/:id/events", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, runLifecycleHandlers.recordRunEvent);
  app.post("/api/runs/:id/start", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, runLifecycleHandlers.startRun);
  app.post("/api/runs/:id/complete", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, runLifecycleHandlers.completeRun);
  app.post("/api/runs/:id/fail", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, runLifecycleHandlers.failRun);
  app.post("/api/runs/:id/cancel", requireAuth, requireScopes("api", "mcp", "runner"), runLifecycleHandlers.cancelRun);
  app.post("/api/runs/:id/rerun", requireAuth, requireScopes("api", "mcp"), asyncHandler(runRerunHandlers.rerunRun));
  app.post("/api/runs/:id/promote", requireAuth, requireScopes("api", "mcp"), asyncHandler(runPromotionHandlers.promoteRun));

  app.get("/api/runs/:id/artifacts", requireAuth, artifactHandlers.listRunArtifacts);
  app.post("/api/runs/:id/artifacts", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, artifactHandlers.createRunArtifact);
  app.get("/api/artifacts", requireAuth, artifactHandlers.listArtifacts);
  app.get("/api/artifacts/:id/download", requireAuth, artifactHandlers.downloadArtifact);

  app.get("/api/approvals", requireAuth, approvalHandlers.listApprovals);
  app.get("/api/approvals/:id", requireAuth, approvalHandlers.getApproval);
  app.post("/api/approvals", requireAuth, requireScopes("api", "mcp", "runner", "approvals"), asyncHandler(approvalHandlers.createApproval));
  app.post("/api/approvals/:id/approve", requireAuth, requireScopes("api", "mcp", "approvals"), approvalHandlers.approve);
  app.post("/api/approvals/:id/reject", requireAuth, requireScopes("api", "mcp", "approvals"), approvalHandlers.reject);
  app.post("/api/approvals/:id/request-changes", requireAuth, requireScopes("api", "mcp", "approvals"), approvalHandlers.requestChanges);

  registerRunnerRoutes(app, { requireAuth, requireScopes });

  app.get("/api/chat/status", requireAuth, supportChatHandlers.status);
  app.post("/api/chat", requireAuth, rateLimit({ bucket: "support-chat", max: 60, windowMs: 60_000 }), asyncHandler(supportChatHandlers.chat));

  app.post("/api/telegram/webhook", asyncHandler(approvalHandlers.telegramWebhook));
}
