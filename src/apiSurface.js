// The API surface registry: the single source of truth for every HTTP route
// the Hub serves. serverRoutes.js registers Express routes FROM this table,
// openApiDocument() generates its paths FROM this table, and
// tests/api-surface.test.js fails when the MCP tool list, the OpenAPI
// document, or the web app drift from it.
//
// Adding an endpoint therefore forces three decisions in one place:
//   1. auth + scopes (what token can call it),
//   2. an OpenAPI summary (how API consumers discover it), and
//   3. either the MCP tool name(s) that expose it or an explicit
//      mcpExempt reason (why agents don't get a tool for it).
// The web UI is an ordinary API client: if the UI needs new data or a new
// action, it must land here first, which makes it automatically visible to
// API and MCP consumers. See docs/api-surface-parity-audit.md.
//
// Entry fields:
//   method       get|post|put|patch|delete|static
//   path         Express path (order in this array is registration order —
//                keep literal paths like /api/schedules/preview ahead of
//                parameterized siblings like /api/schedules/:id)
//   handler      "<depGroup>.<name>" resolved against the deps object passed
//                to registerServerRoutes; null when externally registered
//   wrap         "async" to wrap the handler in asyncHandler
//   auth         true → requireAuth
//   scopes       requireScopes(...scopes); omit for any authenticated token
//   runnerOwner  true → requireRunOwnerOrAdmin
//   secretsGate  true → secretHandlers.requireSecretsEnabled
//   rateLimit    { bucket, max, windowMs }
//   external     registered by another module (routes/runners.js); the
//                interpreter skips it but parity checks still cover it
//   summary      one-line contract shown in openapi.json and the audit doc
//   deprecated   marked deprecated in openapi.json (legacy aliases)
//   openApi      false to keep a route out of openapi.json (non-API pages);
//                defaults to true for /api/* paths, false otherwise
//   mcp          MCP tool name(s) exposing this operation
//   mcpExempt    required when an /api/* operation has no MCP tool
//   ui           true when the web app calls this endpoint (audit metadata,
//                cross-checked against web/ source by the parity test)

export const API_SURFACE = [
  // --- Liveness and version (unauthenticated) ---
  {
    method: "get", path: "/healthz", handler: "publicHandlers.healthz",
    summary: "Liveness probe", openApi: false,
    mcpExempt: "Liveness probe for infrastructure; an MCP session already proves connectivity."
  },
  {
    method: "get", path: "/readyz", handler: "publicHandlers.readyz",
    summary: "Readiness probe", openApi: false,
    mcpExempt: "Readiness probe for infrastructure; an MCP session already proves connectivity."
  },
  {
    method: "get", path: "/api/version", handler: "publicHandlers.apiVersion",
    summary: "Product name, version, and instance name (unauthenticated)",
    mcpExempt: "Version metadata for probes and installers; get_menu identifies the Hub for agents."
  },
  {
    method: "get", path: "/version", handler: "publicHandlers.version",
    summary: "Plain-text version alias of /api/version", openApi: false,
    mcpExempt: "Alias of /api/version for humans and shell scripts."
  },

  // --- Client install assets (unauthenticated) ---
  {
    method: "get", path: "/cli.tgz", handler: "publicHandlers.cliTarball",
    summary: "Download the runyard CLI as a tarball", openApi: false,
    mcpExempt: "Client install asset; MCP callers are already running a client."
  },
  {
    method: "get", path: "/install.sh", handler: "publicHandlers.installScript",
    summary: "Rendered install script for this deployment", openApi: false,
    mcpExempt: "Client install asset; MCP callers are already running a client."
  },

  // --- Browser pages and static assets ---
  {
    method: "get", path: "/", handler: "publicHandlers.landing",
    summary: "Landing page (redirects authenticated sessions to /app)", openApi: false,
    mcpExempt: "Browser page."
  },
  {
    method: "get", path: "/app", handler: "publicHandlers.app",
    summary: "Web app shell (the SPA is an ordinary client of this API)", openApi: false,
    mcpExempt: "Browser page."
  },
  {
    method: "use", path: "/docs", handler: "publicHandlers.docsSite",
    summary: "Documentation site (static Fumadocs build: /docs, /docs/quickstart, concepts and guides)", openApi: false,
    mcpExempt: "Browser docs; agent-facing discovery lives at /llms.txt and /openapi.json."
  },
  {
    method: "static", path: "/public", handler: "publicHandlers.publicDir",
    summary: "Static assets (app bundle, styles, vendor css)", openApi: false,
    mcpExempt: "Static assets."
  },

  // --- Discovery documents ---
  {
    method: "get", path: "/llms.txt", handler: "publicHandlers.llmsTxt",
    summary: "Static agent-facing discovery document", openApi: false,
    mcpExempt: "Discovery document that points agents at MCP; the MCP session already has it."
  },
  {
    method: "get", path: "/openapi.json", handler: "publicHandlers.openApi",
    summary: "This document", openApi: false,
    mcpExempt: "Discovery document generated from this registry."
  },
  {
    method: "get", path: "/api/menu", handler: "publicHandlers.menu",
    auth: true, scopes: ["api", "mcp"], ui: false,
    summary: "Discover the Runyard MCP/CLI menu: tools, workflow catalog, and local/remote execution modes (same source as get_menu and /llms.txt)",
    mcp: ["get_menu"]
  },

  // --- Session and identity ---
  {
    method: "get", path: "/api/setup", handler: "authHandlers.setup", ui: true,
    summary: "Deployment identity for the login screen and Settings. Unauthenticated callers get a reduced payload (instance name, auth mode); the full payload requires a session.",
    mcpExempt: "Browser login/bootstrap probe; authenticated equivalents are whoami and get_menu."
  },
  {
    method: "post", path: "/api/auth/token-login", handler: "authHandlers.tokenLogin",
    rateLimit: { bucket: "login", max: 10, windowMs: 60_000 }, ui: true,
    summary: "Exchange an access token for a browser session cookie. The session carries exactly the token's scopes — no extra power.",
    mcpExempt: "Browser session bootstrap; MCP authenticates every call with the bearer token directly."
  },
  {
    method: "post", path: "/api/auth/telegram-webapp", handler: "authHandlers.telegramWebAppLogin",
    rateLimit: { bucket: "telegram-webapp-login", max: 30, windowMs: 60_000 }, ui: true,
    summary: "Authenticate a Telegram WebApp session (approvals-scoped, narrower than a token session)",
    mcpExempt: "Telegram-specific session bootstrap."
  },
  {
    method: "post", path: "/api/auth/logout", handler: "authHandlers.logout", ui: true,
    summary: "Clear the browser session cookie",
    mcpExempt: "Browser session teardown; bearer tokens are revoked with revoke_token."
  },
  {
    method: "get", path: "/api/me", handler: "authHandlers.me", auth: true, ui: true,
    summary: "Describe the authenticated token: name and scopes",
    mcp: ["whoami"]
  },

  // --- Access tokens (admin) ---
  {
    method: "get", path: "/api/tokens", handler: "tokenHandlers.listTokens",
    auth: true, scopes: ["admin"], ui: true,
    summary: "List access tokens (admin)",
    mcp: ["list_tokens"]
  },
  {
    method: "post", path: "/api/tokens", handler: "tokenHandlers.createToken",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Issue a scoped access token (admin)",
    mcp: ["create_token"]
  },
  {
    method: "delete", path: "/api/tokens/:id", handler: "tokenHandlers.revokeToken",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Revoke an access token (admin)",
    mcp: ["revoke_token"]
  },

  // --- Admin reads ---
  {
    method: "get", path: "/api/audit", handler: "adminReadHandlers.listAudit",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Read the audit log (admin)",
    mcp: ["get_audit_log"]
  },
  {
    method: "get", path: "/api/alerts", handler: "adminReadHandlers.listAlerts",
    auth: true, scopes: ["admin"],
    summary: "List failure alerts (admin)",
    mcp: ["list_alerts"]
  },

  // --- Hub self-update (admin) ---
  {
    method: "get", path: "/api/update-status", handler: "updateHandlers.status", wrap: "async",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Report whether a newer Hub release is available and the current update state (admin)",
    mcp: ["get_update_status"]
  },
  {
    method: "post", path: "/api/update/apply", handler: "updateHandlers.apply",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Apply the available Hub update (admin)",
    mcp: ["apply_update"]
  },

  // --- Secrets (admin, encrypted store) ---
  {
    method: "get", path: "/api/secrets", handler: "secretHandlers.listSecrets",
    auth: true, scopes: ["admin"], secretsGate: true, ui: true,
    summary: "List secret names and metadata, never values (admin)",
    mcp: ["list_secrets"]
  },
  {
    method: "put", path: "/api/secrets/:key", handler: "secretHandlers.upsertSecret",
    auth: true, scopes: ["admin"], secretsGate: true, ui: true,
    summary: "Create/update an encrypted secret (admin). Body: {value, description?}",
    mcp: ["set_secret"]
  },
  {
    method: "delete", path: "/api/secrets/:key", handler: "secretHandlers.deleteSecret",
    auth: true, scopes: ["admin"], secretsGate: true, ui: true,
    summary: "Delete a secret (admin)",
    mcp: ["delete_secret"]
  },

  // --- Workflow endpoints (fixed-purpose webhooks) ---
  {
    method: "get", path: "/api/workflow-endpoints", handler: "workflowEndpointHandlers.listWorkflowEndpoints",
    auth: true, scopes: ["admin"],
    summary: "List configured authenticated workflow endpoints (admin)",
    mcp: ["list_workflow_endpoints"]
  },
  {
    method: "post", path: "/api/workflow-endpoints", handler: "workflowEndpointHandlers.upsertWorkflowEndpoint",
    auth: true, scopes: ["admin"],
    summary: "Create/update an authenticated workflow endpoint (admin)",
    mcp: ["upsert_workflow_endpoint"]
  },
  {
    method: "get", path: "/api/workflow-endpoints/:endpointSlug", handler: "workflowEndpointHandlers.getWorkflowEndpoint",
    auth: true, scopes: ["admin"],
    summary: "Describe a workflow endpoint (admin)",
    mcp: ["get_workflow_endpoint"]
  },
  {
    method: "post", path: "/api/workflow-endpoints/:endpointSlug", handler: "workflowEndpointHandlers.submitWorkflowEndpoint", wrap: "async",
    summary: "Submit data to a fixed authenticated workflow endpoint (per-endpoint secret, rate-limited, deduped)",
    mcp: ["submit_workflow_endpoint"]
  },

  // --- Workflow bundles (immutable DB-stored workflow source) ---
  {
    method: "get", path: "/api/workflow-bundles", handler: "workflowBundleHandlers.listWorkflowBundles",
    auth: true,
    summary: "List workflow source bundles (immutable, versioned, hash-addressed workflow source stored in the Hub DB). ?capability=<slug> filters; listing never includes source bytes.",
    mcp: ["list_workflow_bundles"]
  },
  {
    method: "post", path: "/api/workflow-bundles", handler: "workflowBundleHandlers.publishWorkflowBundle",
    auth: true, scopes: ["admin"],
    summary: "Publish workflow source bytes as a new immutable bundle version (admin)",
    mcp: ["publish_workflow_bundle"]
  },
  {
    method: "get", path: "/api/workflow-bundles/:id", handler: "workflowBundleHandlers.getWorkflowBundle",
    auth: true,
    summary: "Get a workflow bundle, including its source code",
    mcp: ["get_workflow_bundle"]
  },

  // --- Workflow packages (portable export/import files, admin) ---
  {
    method: "get", path: "/api/workflow-packages/workflows/:id/export", handler: "workflowPackageHandlers.exportWorkflowPackage",
    auth: true, scopes: ["admin"],
    summary: "Export a workflow as a portable .runyard-workflow.json package file (admin). The file contains workflow source bytes, metadata, requirements, and content/workflow hashes; secret values are never included.",
    mcp: ["export_workflow_package"]
  },
  {
    method: "get", path: "/api/workflow-packages/capabilities/:id/export", handler: "workflowPackageHandlers.exportWorkflowPackage",
    auth: true, scopes: ["admin"], deprecated: true,
    summary: "Legacy alias of /workflow-packages/workflows/{id}/export",
    mcpExempt: "Legacy path alias; export_workflow_package uses the workflows path."
  },
  {
    method: "post", path: "/api/workflow-packages/validate", handler: "workflowPackageHandlers.validateWorkflowPackage",
    auth: true, scopes: ["admin"],
    summary: "Validate a workflow package file without importing it (admin). Accepts {workflowPackage} or the raw package JSON and checks schema, source hash, content hash, and size limits.",
    mcp: ["validate_workflow_package"]
  },
  {
    method: "post", path: "/api/workflow-packages/preview", handler: "workflowPackageHandlers.previewWorkflowPackageImport",
    auth: true, scopes: ["admin"],
    summary: "Preview importing a workflow package (admin). Accepts optional slug/targetSlug and returns the disabled workflow shape plus requirements report; no rows are written.",
    mcp: ["preview_workflow_import"]
  },
  {
    method: "post", path: "/api/workflow-packages/import", handler: "workflowPackageHandlers.importWorkflowPackage",
    auth: true, scopes: ["admin"],
    summary: "Import a workflow package file (admin). Publishes source as an immutable DB workflow bundle and upserts the workflow disabled by default for local configuration/preflight before enabling.",
    mcp: ["import_workflow_package"]
  },

  // --- Operator reads ---
  {
    method: "get", path: "/api/dashboard", handler: "operatorReadHandlers.dashboard",
    auth: true, ui: true,
    summary: "Dashboard summary: run counts by status, recent activity, and attention items (same data as the web Home header)",
    mcp: ["get_dashboard"]
  },
  {
    method: "get", path: "/api/repo-options", handler: "operatorReadHandlers.repoOptions",
    auth: true, ui: true,
    summary: "List allowlisted repos/projects runs can target, without exposing raw runner paths",
    mcp: ["list_repo_options"]
  },

  // --- Post-run hook profiles ---
  // Discovery is authenticated (non-admins see only enabled profiles in a
  // caller-safe shape); every mutation and readiness probe is admin-only,
  // like workflow endpoints and secrets.
  {
    method: "get", path: "/api/hooks", handler: "hookProfileHandlers.listHookProfiles",
    auth: true,
    summary: "List post-run hook profiles. Non-admin callers see enabled profiles in a caller-safe shape; ?workflow=<slug> narrows to profiles that workflow may select via input.postRunHooks. Admins with ?all=1 see every profile with config + readiness.",
    mcp: ["list_hooks"]
  },
  {
    method: "get", path: "/api/hooks/:slug", handler: "hookProfileHandlers.getHookProfile",
    auth: true,
    summary: "Describe a hook profile",
    mcp: ["get_hook"]
  },
  {
    method: "post", path: "/api/hooks", handler: "hookProfileHandlers.upsertHookProfile",
    auth: true, scopes: ["admin"],
    summary: "Create/update a post-run hook profile (admin). Bounded per-kind config; secrets referenced by name only.",
    mcp: ["upsert_hook"]
  },
  {
    method: "patch", path: "/api/hooks/:slug", handler: "hookProfileHandlers.upsertHookProfile",
    auth: true, scopes: ["admin"],
    summary: "Update a hook profile (admin)",
    mcp: ["upsert_hook"]
  },
  {
    method: "post", path: "/api/hooks/:slug/validate", handler: "hookProfileHandlers.validateHookProfile",
    auth: true, scopes: ["admin"],
    summary: "Dry-run readiness check for a hook profile (admin): reports hook_config_required with missing secret names only",
    mcp: ["validate_hook"]
  },

  // --- Workflows (the catalog) ---
  {
    method: "get", path: "/api/workflows", handler: "capabilityHandlers.listWorkflows",
    auth: true, ui: true,
    summary: "List workflows (?q= searches)",
    mcp: ["list_workflows", "search_workflows"]
  },
  {
    method: "post", path: "/api/workflows", handler: "capabilityHandlers.createWorkflow",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Create workflow (admin). Custom workflows must carry source bytes or a workflow.bundleId; bare workflow.entry file paths are rejected.",
    mcp: ["create_workflow"]
  },
  {
    method: "get", path: "/api/workflows/:id", handler: "capabilityHandlers.getWorkflow",
    auth: true, ui: true,
    summary: "Describe workflow and its input schema",
    mcp: ["describe_workflow"]
  },
  {
    method: "get", path: "/api/workflows/:name/versions", handler: "capabilityHandlers.getWorkflowVersions",
    auth: true,
    summary: "List versions seen from previous runs for a workflow",
    mcp: ["list_workflow_versions"]
  },
  {
    method: "get", path: "/api/workflows/:id/source", handler: "capabilityHandlers.getWorkflowSource",
    auth: true, ui: true,
    summary: "Get workflow source, parsed metadata, sections, and graph",
    mcp: ["get_workflow_source"]
  },
  {
    method: "patch", path: "/api/workflows/:id", handler: "capabilityHandlers.updateWorkflow",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Update workflow (admin)",
    mcp: ["update_workflow"]
  },
  {
    method: "delete", path: "/api/workflows/:id", handler: "capabilityHandlers.deleteWorkflow",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Disable workflow (admin)",
    mcp: ["delete_workflow"]
  },
  {
    method: "post", path: "/api/workflows/:id/run", handler: "capabilityHandlers.runWorkflow", wrap: "async",
    auth: true, scopes: ["api", "mcp"], ui: true,
    summary: "Run workflow. Body: {input, executionMode: local|remote}. For agent-created runs, input.title is recommended as a short human-readable run title for run lists, approval cards, and handoff. improve.repoDir selects an allowlisted runner-local repo while logs/artifacts stay in the Hub. Accepts an optional responseEndpoint ({type: http|telegram, config}) so the caller can have the terminal-state reply delivered when the run finishes. Polling /runs/{id} remains the canonical fallback. Pass negotiate: true to preflight first.",
    mcp: ["run_workflow"]
  },
  {
    method: "post", path: "/api/workflows/:id/preflight", handler: "capabilityHandlers.preflightWorkflow",
    auth: true, scopes: ["api", "mcp"],
    summary: "Dry-run the deterministic run-creation preflight. Body: {input, executionMode}. Returns {negotiation: {status: ready|needs_input|blocked, input (normalized), questions, blockers, warnings, suggestedDefaults, checks, nextAction}}; nothing is created or enqueued.",
    mcp: ["preflight_workflow"]
  },

  // --- Capabilities (legacy HTTP aliases of /api/workflows) ---
  {
    method: "get", path: "/api/capabilities", handler: "capabilityHandlers.listCapabilities",
    auth: true, deprecated: true,
    summary: "Legacy alias of GET /workflows",
    mcpExempt: "Legacy alias; list_workflows is the tool (the dispatcher still accepts *_capability names)."
  },
  {
    method: "post", path: "/api/capabilities", handler: "capabilityHandlers.createCapability",
    auth: true, scopes: ["admin"], deprecated: true,
    summary: "Legacy alias of POST /workflows",
    mcpExempt: "Legacy alias of POST /workflows."
  },
  {
    method: "get", path: "/api/capabilities/:id", handler: "capabilityHandlers.getCapability",
    auth: true, deprecated: true,
    summary: "Legacy alias of GET /workflows/{id}",
    mcpExempt: "Legacy alias of GET /workflows/{id}."
  },
  {
    method: "get", path: "/api/capabilities/:name/versions", handler: "capabilityHandlers.getCapabilityVersions",
    auth: true, deprecated: true,
    summary: "Legacy alias of GET /workflows/{name}/versions",
    mcpExempt: "Legacy alias of GET /workflows/{name}/versions."
  },
  {
    method: "get", path: "/api/capabilities/:id/source", handler: "capabilityHandlers.getCapabilitySource",
    auth: true, deprecated: true,
    summary: "Legacy alias of GET /workflows/{id}/source",
    mcpExempt: "Legacy alias of GET /workflows/{id}/source."
  },
  {
    method: "patch", path: "/api/capabilities/:id", handler: "capabilityHandlers.updateCapability",
    auth: true, scopes: ["admin"], deprecated: true,
    summary: "Legacy alias of PATCH /workflows/{id}",
    mcpExempt: "Legacy alias of PATCH /workflows/{id}."
  },
  {
    method: "post", path: "/api/capabilities/:id/run", handler: "capabilityHandlers.runCapability", wrap: "async",
    auth: true, scopes: ["api", "mcp"], deprecated: true,
    summary: "Legacy alias of POST /workflows/{id}/run",
    mcpExempt: "Legacy alias of POST /workflows/{id}/run."
  },
  {
    method: "post", path: "/api/capabilities/:id/preflight", handler: "capabilityHandlers.preflightCapability",
    auth: true, scopes: ["api", "mcp"], deprecated: true,
    summary: "Legacy alias of POST /workflows/{id}/preflight",
    mcpExempt: "Legacy alias of POST /workflows/{id}/preflight."
  },

  // --- Run drafts (run-creation negotiation) ---
  // Reads are any-auth (like /api/runs); every mutation needs the same
  // api/mcp scopes as starting a run.
  {
    method: "get", path: "/api/run-drafts", handler: "runDraftHandlers.listRunDrafts",
    auth: true,
    summary: "List run drafts (filter: status, workflow). A draft is a proposed run that has NOT been enqueued; its status mirrors the latest preflight until submitted or discarded.",
    mcp: ["list_run_drafts"]
  },
  {
    method: "post", path: "/api/run-drafts", handler: "runDraftHandlers.createRunDraft",
    auth: true, scopes: ["api", "mcp"],
    summary: "Create a run draft and preflight it. Body: {workflow, input, executionMode}. Returns 201 with the draft (status ready|needs_input|blocked, preflight report, questions to answer).",
    mcp: ["create_run_draft"]
  },
  {
    method: "get", path: "/api/run-drafts/:id", handler: "runDraftHandlers.getRunDraft",
    auth: true,
    summary: "Get a run draft with its latest preflight report",
    mcp: ["get_run_draft"]
  },
  {
    method: "patch", path: "/api/run-drafts/:id", handler: "runDraftHandlers.patchRunDraft",
    auth: true, scopes: ["api", "mcp"],
    summary: "Answer questions / edit a draft: body.input is shallow-merged into the draft input (null deletes a key; replaceInput: true replaces it), executionMode/runnerLocation update options; the draft is re-preflighted and its status updated.",
    mcp: ["update_run_draft"]
  },
  {
    method: "post", path: "/api/run-drafts/:id/submit", handler: "runDraftHandlers.submitRunDraft", wrap: "async",
    auth: true, scopes: ["api", "mcp"],
    summary: "Submit a run draft: re-preflights and enqueues the real run only when ready (202 with {run, draft}); otherwise 422 (needs_input) or 409 (blocked) with the refreshed negotiation state and no run created.",
    mcp: ["submit_run_draft"]
  },
  {
    method: "post", path: "/api/run-drafts/:id/discard", handler: "runDraftHandlers.discardRunDraft",
    auth: true, scopes: ["api", "mcp"],
    summary: "Discard an open run draft (abandon the negotiation)",
    mcp: ["discard_run_draft"]
  },

  // --- Schedules (cron and one-shot) ---
  {
    method: "get", path: "/api/schedules", handler: "scheduleHandlers.listSchedules",
    auth: true, ui: true,
    summary: "List schedules (cron jobs) with next/last run and a human-readable preview",
    mcp: ["list_schedules"]
  },
  {
    method: "get", path: "/api/schedules/preview", handler: "scheduleHandlers.previewSchedule",
    auth: true, ui: true,
    summary: "Validate a cron expression (query: cron, timezone) and return a description plus the next fire times",
    mcp: ["preview_schedule"]
  },
  {
    method: "get", path: "/api/schedules/:id", handler: "scheduleHandlers.getSchedule",
    auth: true, ui: true,
    summary: "Get a schedule",
    mcp: ["get_schedule"]
  },
  {
    method: "post", path: "/api/schedules", handler: "scheduleHandlers.createSchedule",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Create a schedule (admin). Body: {name, workflowSlug, cron|runAt, timezone, input, enabled}. Cron schedules fire recurringly; runAt fires once. Fires honor the workflow's approval policy.",
    mcp: ["create_schedule"]
  },
  {
    method: "patch", path: "/api/schedules/:id", handler: "scheduleHandlers.updateSchedule",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Update a schedule (admin)",
    mcp: ["update_schedule"]
  },
  {
    method: "post", path: "/api/schedules/:id/enable", handler: "scheduleHandlers.enableSchedule",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Enable a schedule (admin)",
    mcp: ["enable_schedule"]
  },
  {
    method: "post", path: "/api/schedules/:id/disable", handler: "scheduleHandlers.disableSchedule",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Disable a schedule (admin)",
    mcp: ["disable_schedule"]
  },
  {
    method: "delete", path: "/api/schedules/:id", handler: "scheduleHandlers.deleteSchedule",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Delete a schedule (admin)",
    mcp: ["delete_schedule"]
  },
  {
    method: "post", path: "/api/schedules/:id/run-now", handler: "scheduleHandlers.runScheduleNowRoute", wrap: "async",
    auth: true, scopes: ["api", "mcp", "admin"],
    rateLimit: { bucket: "schedule-run-now", max: 60, windowMs: 60_000 }, ui: true,
    summary: "Fire a schedule immediately without changing its cadence",
    mcp: ["run_schedule_now"]
  },

  // --- Catalog: agents / skills / knowledge ---
  {
    method: "get", path: "/api/agents", handler: "catalogHandlers.agents.list",
    auth: true, ui: true,
    summary: "List reusable agent roles",
    mcp: ["list_agents"]
  },
  {
    method: "post", path: "/api/agents", handler: "catalogHandlers.agents.create",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Create an agent role (admin)",
    mcp: ["create_agent"]
  },
  {
    method: "patch", path: "/api/agents/:slug", handler: "catalogHandlers.agents.update",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Update an agent role (admin)",
    mcp: ["update_agent"]
  },
  {
    method: "get", path: "/api/skills", handler: "catalogHandlers.skills.list",
    auth: true, ui: true,
    summary: "List skills",
    mcp: ["list_skills"]
  },
  {
    method: "post", path: "/api/skills", handler: "catalogHandlers.skills.create",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Create a skill (admin)",
    mcp: ["create_skill"]
  },
  {
    method: "patch", path: "/api/skills/:slug", handler: "catalogHandlers.skills.update",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Update a skill (admin)",
    mcp: ["update_skill"]
  },
  {
    method: "get", path: "/api/knowledge", handler: "catalogHandlers.knowledge.list",
    auth: true, ui: true,
    summary: "List knowledge resources (?q= searches)",
    mcp: ["search_knowledge"]
  },
  {
    method: "post", path: "/api/knowledge", handler: "catalogHandlers.knowledge.create",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Create a knowledge resource (admin)",
    mcp: ["create_knowledge"]
  },
  {
    method: "patch", path: "/api/knowledge/:slug", handler: "catalogHandlers.knowledge.update",
    auth: true, scopes: ["admin"], ui: true,
    summary: "Update a knowledge resource (admin)",
    mcp: ["update_knowledge"]
  },

  // --- Runs ---
  {
    method: "get", path: "/api/runs", handler: "runReadHandlers.listRuns",
    auth: true, ui: true,
    summary: "List runs (filter by status, q, workflow)",
    mcp: ["list_runs"]
  },
  {
    method: "get", path: "/api/runs/:id", handler: "runReadHandlers.getRun",
    auth: true, ui: true,
    summary: "Get run: status, outputs, error, and responseEndpoints[] delivery state",
    mcp: ["get_run_status"]
  },
  {
    method: "get", path: "/api/runs/:id/events", handler: "runReadHandlers.listRunEvents",
    auth: true, ui: true,
    summary: "Get run events",
    mcp: ["get_run_events"]
  },
  {
    method: "get", path: "/api/runs/:id/events/stream", handler: "runReadHandlers.streamRunEvents",
    auth: true, ui: true,
    summary: "Live run events over Server-Sent Events (the web console's live feed; poll /runs/{id}/events for the same data)",
    mcpExempt: "SSE stream; MCP tools poll get_run_events / get_run_timeline for the same data."
  },
  {
    method: "get", path: "/api/runs/:id/log-summary", handler: "runReadHandlers.getRunLogSummary",
    auth: true,
    summary: "Get the run's log summary on its own (also embedded in /runs/{id} and /runs/{id}/diagnostics)",
    mcpExempt: "Covered by get_run_diagnostics, which returns diagnostics plus this log summary."
  },
  {
    method: "get", path: "/api/runs/:id/diagnostics", handler: "runReadHandlers.getRunDiagnostics",
    auth: true, ui: true,
    summary: "Get diagnostics and log summary for a run",
    mcp: ["get_run_diagnostics"]
  },
  {
    method: "get", path: "/api/runs/:id/logs", handler: "runReadHandlers.getRunLogs",
    auth: true, ui: true,
    summary: "Get run log lines",
    mcp: ["get_run_logs"]
  },
  {
    method: "get", path: "/api/runs/:id/timeline", handler: "runReadHandlers.getRunTimeline",
    auth: true,
    summary: "Get a unified ascending run timeline built from status transitions, events, and artifacts. Supports since=<iso> and limit=<n>; used by `runyard tail`.",
    mcp: ["get_run_timeline"]
  },
  {
    method: "post", path: "/api/runs/:id/events", handler: "runLifecycleHandlers.recordRunEvent",
    auth: true, scopes: ["runner"], runnerOwner: true,
    summary: "Append run event (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope + run ownership)."
  },
  {
    method: "post", path: "/api/runs/:id/start", handler: "runLifecycleHandlers.startRun",
    auth: true, scopes: ["runner"], runnerOwner: true,
    summary: "Mark a claimed run as started (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope + run ownership)."
  },
  {
    method: "post", path: "/api/runs/:id/complete", handler: "runLifecycleHandlers.completeRun",
    auth: true, scopes: ["runner"], runnerOwner: true,
    summary: "Complete a run with outputs (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope + run ownership)."
  },
  {
    method: "post", path: "/api/runs/:id/fail", handler: "runLifecycleHandlers.failRun",
    auth: true, scopes: ["runner"], runnerOwner: true,
    summary: "Fail a run with an error (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope + run ownership)."
  },
  {
    method: "post", path: "/api/runs/:id/cancel", handler: "runLifecycleHandlers.cancelRun",
    auth: true, scopes: ["api", "mcp", "runner"], ui: true,
    summary: "Cancel a queued or running run",
    mcp: ["cancel_run"]
  },
  {
    method: "post", path: "/api/runs/:id/rerun", handler: "runRerunHandlers.rerunRun", wrap: "async",
    auth: true, scopes: ["api", "mcp"], ui: true,
    summary: "Re-queue the run with the same or edited input",
    mcp: ["rerun_workflow_run"]
  },
  {
    method: "post", path: "/api/runs/:id/promote", handler: "runPromotionHandlers.promoteRun", wrap: "async",
    auth: true, scopes: ["api", "mcp"], ui: true,
    summary: "Merge a successful isolated worktree run into its target branch, run gates, push, and clean up the branch/worktree",
    mcp: ["promote_run"]
  },

  // --- Artifacts ---
  {
    method: "get", path: "/api/runs/:id/artifacts", handler: "artifactHandlers.listRunArtifacts",
    auth: true, ui: true,
    summary: "List run artifacts",
    mcp: ["get_run_artifacts"]
  },
  {
    method: "post", path: "/api/runs/:id/artifacts", handler: "artifactHandlers.createRunArtifact",
    auth: true, scopes: ["runner"], runnerOwner: true,
    summary: "Upload artifact (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope + run ownership)."
  },
  {
    method: "get", path: "/api/artifacts", handler: "artifactHandlers.listArtifacts",
    auth: true, ui: true,
    summary: "List/search artifacts across runs (?q= searches)",
    mcp: ["search_artifacts"]
  },
  {
    method: "get", path: "/api/artifacts/:id/download", handler: "artifactHandlers.downloadArtifact",
    auth: true, ui: true,
    summary: "Download an artifact's bytes",
    mcp: ["download_artifact"]
  },

  // --- Approvals ---
  {
    method: "get", path: "/api/approvals", handler: "approvalHandlers.listApprovals",
    auth: true, ui: true,
    summary: "List approvals. ?status=pending|resolved filters; resolved cards carry the decision in their resolution field.",
    mcp: ["list_approvals", "list_pending_approvals"]
  },
  {
    method: "get", path: "/api/approvals/:id", handler: "approvalHandlers.getApproval",
    auth: true, ui: true,
    summary: "Get a single approval card",
    mcp: ["get_approval"]
  },
  {
    method: "post", path: "/api/approvals", handler: "approvalHandlers.createApproval", wrap: "async",
    auth: true, scopes: ["api", "mcp", "runner", "approvals"],
    summary: "Create an approval card for a human decision. Body: {title, description, runId?, ask: {action, reason, audience}, timeoutMs?/timeoutAt? + fallback? for timed approvals}.",
    mcp: ["create_approval"]
  },
  {
    method: "post", path: "/api/approvals/:id/approve", handler: "approvalHandlers.approve",
    auth: true, scopes: ["api", "mcp", "approvals"], ui: true,
    summary: "Approve request",
    mcp: ["approve_run"]
  },
  {
    method: "post", path: "/api/approvals/:id/reject", handler: "approvalHandlers.reject",
    auth: true, scopes: ["api", "mcp", "approvals"], ui: true,
    summary: "Reject request",
    mcp: ["reject_run"]
  },
  {
    method: "post", path: "/api/approvals/:id/request-changes", handler: "approvalHandlers.requestChanges",
    auth: true, scopes: ["api", "mcp", "approvals"], ui: true,
    summary: "Request changes",
    mcp: ["request_changes_run"]
  },

  // --- Runners (registered by routes/runners.js) ---
  {
    method: "post", path: "/api/runners/register", handler: null, external: "runners",
    auth: true, scopes: ["runner"],
    summary: "Register runner (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope)."
  },
  {
    method: "get", path: "/api/runners", handler: null, external: "runners",
    auth: true, ui: true,
    summary: "List registered runners, heartbeat state, capacity, active slots, and pool summary",
    mcp: ["list_runners"]
  },
  {
    method: "post", path: "/api/runners/:id/heartbeat", handler: null, external: "runners",
    auth: true, scopes: ["runner"],
    summary: "Runner heartbeat (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope)."
  },
  {
    method: "get", path: "/api/runners/:id/next-run", handler: null, external: "runners",
    auth: true, scopes: ["runner"],
    summary: "Claim next run for runner (runner protocol)",
    mcpExempt: "Runner-to-Hub machine protocol (runner scope)."
  },

  // --- In-app assistant ---
  {
    method: "get", path: "/api/chat/status", handler: "supportChatHandlers.status",
    auth: true, ui: true,
    summary: "In-app Assistant status: resolved provider (runner|anthropic|openai) and whether it is configured",
    mcp: ["get_assistant_status"]
  },
  {
    method: "post", path: "/api/chat", handler: "supportChatHandlers.chat", wrap: "async",
    auth: true, rateLimit: { bucket: "support-chat", max: 60, windowMs: 60_000 }, ui: true,
    summary: "Ask the in-app Assistant. Body: {messages, context}. Answers first; any app-changing action is returned as a confirmation button, never executed server-side.",
    mcp: ["ask_assistant"]
  },

  // --- Telegram ---
  {
    method: "post", path: "/api/telegram/webhook", handler: "approvalHandlers.telegramWebhook", wrap: "async",
    summary: "Telegram bot callback (verified against the configured bot; not a general API)",
    openApi: false,
    mcpExempt: "External Telegram callback; approvals have first-class tools."
  }
];

// Convert an Express path under /api into its OpenAPI form relative to the
// `${baseUrl}/api` server: strip the /api prefix and turn :params into
// {params}. Returns null for routes that live outside /api.
export function openApiPathFor(operation) {
  if (operation.openApi === false) return null;
  if (!operation.path.startsWith("/api/")) return null;
  const relative = operation.path.slice("/api".length);
  return relative.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

// Build the OpenAPI `paths` object from the registry. Two registry entries
// may share a path with different methods; the first summary wins per
// (path, method) — duplicates would be a registry bug the parity test catches.
export function openApiPathsFromSurface(surface = API_SURFACE) {
  const paths = {};
  for (const operation of surface) {
    const path = openApiPathFor(operation);
    if (!path || operation.method === "static") continue;
    paths[path] ||= {};
    const entry = { summary: operation.summary };
    if (operation.deprecated) entry.deprecated = true;
    paths[path][operation.method] = entry;
  }
  return paths;
}

// Every MCP tool name the registry expects to exist, with the operations it
// covers. Used by the parity test in both directions.
export function mcpToolCoverage(surface = API_SURFACE) {
  const coverage = new Map();
  for (const operation of surface) {
    for (const tool of operation.mcp || []) {
      if (!coverage.has(tool)) coverage.set(tool, []);
      coverage.get(tool).push(`${operation.method.toUpperCase()} ${operation.path}`);
    }
  }
  return coverage;
}

// Operations that intentionally have no MCP tool must say why.
export function mcpExemptOperations(surface = API_SURFACE) {
  return surface.filter((operation) => !(operation.mcp || []).length);
}
