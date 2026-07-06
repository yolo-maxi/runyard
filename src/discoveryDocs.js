// Tool names shared by the authenticated menu payload and the public llms.txt.
// These are the same for every deployment; only the workflow catalog is private.
const HUB_TOOL_NAMES = [
  "get_menu",
  "list_workflows",
  "describe_workflow",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "preflight_workflow",
  "run_workflow",
  "get_run_status",
  "get_run_logs",
  "get_run_artifacts",
  "list_runners",
  "list_pending_approvals",
  "list_approvals",
  "list_hooks",
  "list_schedules",
  "create_schedule",
  "download_artifact"
];

const RUN_TITLE_RECOMMENDATION = "For agent-created runs, include input.title: a short human-readable title that explains the specific job.";

const RUN_PREFLIGHT_RECOMMENDATION = "When the input is rough or unverified, preflight first (preflight_workflow / POST /api/workflows/{id}/preflight or run_workflow with negotiate: true): a non-ready request comes back as ready|needs_input|blocked with questions and blockers instead of becoming a failed run.";

export function hubMenuPayload({ baseUrl, workflows = null, capabilities = [], pool = null } = {}) {
  const catalog = workflows || capabilities;
  const linkedWorkflows = catalog.map((linked) => ({
    slug: linked.slug,
    name: linked.name,
    description: linked.description,
    category: linked.category,
    requiredRunnerTags: linked.requiredRunnerTags,
    deepLink: linked.deepLink,
    runWithCli: `runyard run ${linked.slug} --where local --input '{"title":"Short human-readable run title"}'`,
    runWithMcp: {
      tool: "run_workflow",
      arguments: { id: linked.slug, input: { title: "Short human-readable run title" }, executionMode: "local" }
    }
  }));
  return {
    product: "Runyard",
    codebase: "runyard",
    hub: {
      sourceOfTruth: true,
      status: `${baseUrl}/api/runs/{runId}`,
      logs: `${baseUrl}/api/runs/{runId}/logs`,
      artifacts: `${baseUrl}/api/runs/{runId}/artifacts`,
      note: "Runs, outputs, logs, and artifacts are recorded in the Hub even when execution happens on a local runner. For improve, repoDir selects the allowlisted runner-local git repo to edit; the Hub remains the source of truth for logs and artifacts."
    },
    discovery: [
      { surface: "MCP", action: "Call get_menu, then list_workflows or describe_workflow." },
      { surface: "CLI", action: "Run runyard menu, then runyard workflows or runyard workflow describe <slug>." },
      { surface: "Web", action: "Open /app and use Workflows, Runs, Approvals, and Connect." }
    ],
    executionModes: [
      {
        id: "local",
        label: "Run locally",
        runnerLocation: "local",
        cli: "runyard run <workflow> --where local --input '<json>'",
        mcp: { tool: "run_workflow", arguments: { id: "<workflow>", input: {}, executionMode: "local" } },
        runner: "runyard runner start --location local",
        result: "The local runner executes the workflow; outputs and artifacts are fetched from the Hub."
      },
      {
        id: "remote",
        label: "Run remotely",
        runnerLocation: "vps",
        cli: "runyard run <workflow> --where remote --input '<json>'",
        mcp: { tool: "run_workflow", arguments: { id: "<workflow>", input: {}, executionMode: "remote" } },
        runner: "Use the shared VPS/remote runner pool tagged vps or remote.",
        result: "A remote runner executes the workflow; outputs and artifacts are fetched from the Hub."
      }
    ],
    runInputGuidance: {
      title: RUN_TITLE_RECOMMENDATION,
      preflight: RUN_PREFLIGHT_RECOMMENDATION
    },
    tools: [...HUB_TOOL_NAMES],
    workflows: linkedWorkflows,
    pool
  };
}

// The public llms.txt is deliberately static and generic. Each deployment is a
// private company Hub, so the live workflow catalog, secret-file locations,
// and operator configuration stay behind auth (GET /api/menu) and in the
// operator docs — never in an unauthenticated discovery document.
export function renderLlmsTxt(baseUrl) {
  const lines = [];
  lines.push("# Runyard (codebase: runyard)");
  lines.push("");
  lines.push("Self-hosted control plane for agent runs. Agents discover workflows");
  lines.push("over MCP/CLI/HTTP, runners execute them, and the Hub stores the durable");
  lines.push("record of logs, events, artifacts, approvals, skills, agents, and knowledge.");
  lines.push("One private deployment per company/org.");
  lines.push("");
  lines.push("Primary agent interface:");
  lines.push("- MCP server: runyard-mcp");
  lines.push(`- HTTP API: ${baseUrl}/api`);
  lines.push(`- OpenAPI: ${baseUrl}/openapi.json`);
  lines.push(`- Menu (authenticated): ${baseUrl}/api/menu`);
  lines.push(`- Workflow catalog (authenticated): ${baseUrl}/api/workflows`);
  lines.push(`- Setup docs: ${baseUrl}/docs/quickstart`);
  lines.push("");
  lines.push("Tools (mirrors get_menu):");
  for (const tool of HUB_TOOL_NAMES) lines.push(`- ${tool}`);
  lines.push("");
  lines.push("Workflows:");
  lines.push("- This deployment's catalog is private. Authenticate, then call");
  lines.push("  get_menu / list_workflows (MCP), `runyard menu` (CLI), or");
  lines.push(`  GET ${baseUrl}/api/menu (HTTP) for the live list.`);
  lines.push("");
  lines.push("Execution modes:");
  lines.push("- local -> runners tagged local");
  lines.push("- remote -> runners tagged vps or remote");
  lines.push("");
  lines.push("Run input recommendation:");
  lines.push(`- ${RUN_TITLE_RECOMMENDATION}`);
  lines.push("- Keep it concise and specific, e.g. \"Audit checkout flow mobile states\".");
  lines.push("- The title is advisory, not required; it helps approval cards, run");
  lines.push("  lists, and human handoff stay decipherable.");
  lines.push("");
  lines.push("Authenticate with a Hub access token using Bearer auth. Tokens carry");
  lines.push("scopes (api, mcp, runner, admin). Ask this Hub's administrator for a");
  lines.push("token; admins issue them from the Connect tab in the web app.");
  lines.push("");
  lines.push("Run path:");
  lines.push("1. Discover with get_menu / list_workflows.");
  lines.push("2. Choose local or remote execution.");
  lines.push("3. Start with run_workflow or `runyard run --where local|remote`.");
  lines.push("   For agent-created runs, set input.title when practical.");
  lines.push("   Rough or unverified input? Preflight first: preflight_workflow,");
  lines.push("   `runyard preflight <workflow>`, or POST /api/workflows/{id}/preflight.");
  lines.push("4. Fetch status, logs, outputs, artifacts, and the unified timeline from the Hub.");
  lines.push("5. Operators can run `runyard tail <run-id>` for an NDJSON timeline stream.");
  lines.push("");
  lines.push("Response endpoints (optional):");
  lines.push("- POST /api/workflows/:id/run accepts an optional responseEndpoint:");
  lines.push('  { type: "http"|"telegram", config: { ... } }');
  lines.push("- Polling /api/runs/:id is always available and stays canonical.");
  lines.push("- Endpoint config is validated server-side; secrets are not echoed");
  lines.push("  back in API responses, events, or audit log entries.");
  lines.push("- When the run reaches a terminal state (succeeded/failed/cancelled)");
  lines.push("  the Hub posts a sanitized payload to http endpoints and a concise");
  lines.push("  message to telegram endpoints; telegram delivery requires the Hub's");
  lines.push("  Telegram integration to be configured. Delivery state (status /");
  lines.push("  attempts / last_error / delivered_at) is visible on GET /api/runs/:id");
  lines.push("  under responseEndpoints[].");
  lines.push("");
  lines.push("Run-creation negotiation (preflight + drafts):");
  lines.push("- POST /api/workflows/{id}/preflight dry-runs the deterministic");
  lines.push("  preflight (required input fields, runner tags, secrets, hooks,");
  lines.push("  workflow source) and returns ready | needs_input | blocked with");
  lines.push("  questions[], blockers[], warnings[], and suggestedDefaults —");
  lines.push("  nothing is created or enqueued.");
  lines.push("- POST /api/workflows/{id}/run with negotiate: true enqueues only");
  lines.push("  when preflight is ready; otherwise it returns 422 (needs_input) or");
  lines.push("  409 (blocked) with the negotiation state and a saved run draft");
  lines.push("  instead of creating a run that would fail.");
  lines.push("- Drafts: POST /api/run-drafts creates one, PATCH /api/run-drafts/{id}");
  lines.push("  merges answers into the input and re-preflights, and");
  lines.push("  POST /api/run-drafts/{id}/submit enqueues the real run once ready.");
  lines.push("");
  lines.push("Workflow package files:");
  lines.push("- Admins can export a workflow as a portable");
  lines.push("  .runyard-workflow.json file, then validate/preview/import it on another");
  lines.push("  Hub. Imports publish the source as a DB workflow bundle and install the");
  lines.push("  workflow disabled until local secrets/runners/config are ready.");
  lines.push("- CLI: runyard workflow-package export <workflow> -o file.runyard-workflow.json");
  lines.push("  then runyard workflow-package preview|import file.runyard-workflow.json.");
  lines.push("");
  lines.push("Post-run hooks (optional):");
  lines.push("- Side effects after a run's gates pass (static publish, git push,");
  lines.push("  webhook) are explicit hook invocations, never implicit workflow magic.");
  lines.push("- Admins define bounded hook profiles at POST /api/hooks; callers");
  lines.push("  discover eligible profiles at GET /api/hooks?workflow=<slug> and");
  lines.push('  select them per run via input.postRunHooks: ["<profile>"].');
  lines.push("- Hook outcomes surface as hook_failed / hook_config_required /");
  lines.push("  hook_blocked alongside the run result; a failed hook never turns a");
  lines.push("  green build into a failed run.");
  return `${lines.join("\n")}\n`;
}

export function openApiDocument({ baseUrl, version }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Runyard API (runyard)",
      version,
      description:
        "Self-hosted control plane for agent runs. The Web Hub, CLI, and MCP server all drive this same JSON API. " +
        "Authenticate every request with `Authorization: Bearer shub_...`; tokens carry scopes (api, mcp, runner, admin) and the bootstrap token is full admin. " +
        "Typical flow: discover workflows (GET /menu or /workflows), start a run (POST /workflows/{id}/run with executionMode local|remote), then poll /runs/{id} and read /runs/{id}/timeline, /logs, and /artifacts. " +
        "Runs that need a human checkpoint enter waiting_approval and are resolved via /approvals/{id}/approve|reject|request-changes. " +
        "Liveness endpoints (/healthz, /readyz, /api/version) and discovery copy (/llms.txt, this document) are unauthenticated and served from the repo root, not under /api."
    },
    servers: [{ url: `${baseUrl}/api` }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/menu": { get: { summary: "Discover the Runyard MCP/CLI menu: tools, workflow catalog, and local/remote execution modes (same source as get_menu and /llms.txt)" } },
      "/workflows": { get: { summary: "List workflows" }, post: { summary: "Create workflow (admin)" } },
      "/workflows/{id}": { get: { summary: "Describe workflow and its input schema" }, patch: { summary: "Update workflow (admin)" }, delete: { summary: "Disable workflow (admin)" } },
      "/workflows/{id}/run": { post: { summary: "Run workflow. Body: {input, executionMode: local|remote}. For agent-created runs, input.title is recommended as a short human-readable run title for run lists, approval cards, and handoff. improve.repoDir selects an allowlisted runner-local repo while logs/artifacts stay in the Hub. Accepts an optional responseEndpoint ({type: http|telegram, config}) so the caller can have the terminal-state reply delivered when the run finishes. Polling /runs/{id} remains the canonical fallback. Pass negotiate: true to preflight first." } },
      "/workflows/{id}/preflight": { post: { summary: "Dry-run the deterministic run-creation preflight. Body: {input, executionMode}. Returns {negotiation: {status: ready|needs_input|blocked, input (normalized), questions, blockers, warnings, suggestedDefaults, checks, nextAction}}; nothing is created or enqueued." } },
      "/run-drafts": {
        get: { summary: "List run drafts (filter: status, workflow). A draft is a proposed run that has NOT been enqueued; its status mirrors the latest preflight until submitted or discarded." },
        post: { summary: "Create a run draft and preflight it. Body: {workflow, input, executionMode}. Returns 201 with the draft (status ready|needs_input|blocked, preflight report, questions to answer)." }
      },
      "/run-drafts/{id}": {
        get: { summary: "Get a run draft with its latest preflight report" },
        patch: { summary: "Answer questions / edit a draft: body.input is shallow-merged into the draft input (null deletes a key; replaceInput: true replaces it), executionMode/runnerLocation update options; the draft is re-preflighted and its status updated." }
      },
      "/run-drafts/{id}/submit": { post: { summary: "Submit a run draft: re-preflights and enqueues the real run only when ready (202 with {run, draft}); otherwise 422 (needs_input) or 409 (blocked) with the refreshed negotiation state and no run created." } },
      "/run-drafts/{id}/discard": { post: { summary: "Discard an open run draft (abandon the negotiation)" } },
      "/runs": { get: { summary: "List runs (filter by status, q, workflow)" } },
      "/runs/{id}": { get: { summary: "Get run: status, outputs, error, and responseEndpoints[] delivery state" } },
      "/runs/{id}/events": { get: { summary: "Get run events" }, post: { summary: "Append run event (runner)" } },
      "/runs/{id}/timeline": { get: { summary: "Get a unified ascending run timeline built from status transitions, events, and artifacts. Supports since=<iso> and limit=<n>; used by `runyard tail`." } },
      "/runs/{id}/logs": { get: { summary: "Get run log lines" } },
      "/runs/{id}/artifacts": { get: { summary: "List run artifacts" }, post: { summary: "Upload artifact (runner)" } },
      "/runs/{id}/rerun": { post: { summary: "Re-queue the run with the same or edited input" } },
      "/runs/{id}/promote": { post: { summary: "Merge a successful isolated worktree run into its target branch, run gates, push, and clean up the branch/worktree" } },
      "/runs/{id}/cancel": { post: { summary: "Cancel a queued or running run" } },
      "/artifacts/{id}/download": { get: { summary: "Download an artifact's bytes" } },
      "/approvals": {
        get: { summary: "List approvals. ?status=pending|resolved filters; resolved cards carry the decision in their resolution field." },
        post: { summary: "Create an approval card for a human decision. Body: {title, description, runId?, ask: {action, reason, audience}, timeoutMs?/timeoutAt? + fallback? for timed approvals}." }
      },
      "/approvals/{id}": { get: { summary: "Get a single approval card" } },
      "/approvals/{id}/approve": { post: { summary: "Approve request" } },
      "/approvals/{id}/reject": { post: { summary: "Reject request" } },
      "/approvals/{id}/request-changes": { post: { summary: "Request changes" } },
      "/agents": { get: { summary: "List reusable agent roles" }, post: { summary: "Create/update agent (admin)" } },
      "/skills": { get: { summary: "List skills" }, post: { summary: "Create/update skill (admin)" } },
      "/knowledge": { get: { summary: "List knowledge resources" }, post: { summary: "Create/update knowledge resource (admin)" } },
      "/tokens": { get: { summary: "List access tokens (admin)" }, post: { summary: "Issue a scoped access token (admin)" } },
      "/audit": { get: { summary: "Read the audit log (admin)" } },
      "/alerts": { get: { summary: "List failure alerts (admin)" } },
      "/me": { get: { summary: "Describe the authenticated token: name and scopes" } },
      "/secrets": { get: { summary: "List secret names and metadata, never values (admin)" } },
      "/secrets/{key}": { put: { summary: "Create/update an encrypted secret (admin). Body: {value, description?}" }, delete: { summary: "Delete a secret (admin)" } },
      "/chat/status": { get: { summary: "In-app Assistant status: resolved provider (runner|anthropic|openai) and whether it is configured" } },
      "/chat": { post: { summary: "Ask the in-app Assistant. Body: {messages, context}. Answers first; any app-changing action is returned as a confirmation button, never executed server-side." } },
      "/hooks": {
        get: { summary: "List post-run hook profiles. Non-admin callers see enabled profiles in a caller-safe shape; ?workflow=<slug> narrows to profiles that workflow may select via input.postRunHooks. Admins with ?all=1 see every profile with config + readiness." },
        post: { summary: "Create/update a post-run hook profile (admin). Bounded per-kind config; secrets referenced by name only." }
      },
      "/hooks/{slug}": { get: { summary: "Describe a hook profile" }, patch: { summary: "Update a hook profile (admin)" } },
      "/hooks/{slug}/validate": { post: { summary: "Dry-run readiness check for a hook profile (admin): reports hook_config_required with missing secret names only" } },
      "/workflow-endpoints": { get: { summary: "List configured authenticated workflow endpoints (admin)" }, post: { summary: "Create/update an authenticated workflow endpoint (admin)" } },
      "/workflow-endpoints/{slug}": { get: { summary: "Describe a workflow endpoint (admin)" }, post: { summary: "Submit data to a fixed authenticated workflow endpoint (per-endpoint secret, rate-limited, deduped)" } },
      "/workflow-packages/workflows/{id}/export": { get: { summary: "Export a workflow as a portable .runyard-workflow.json package file (admin). The file contains workflow source bytes, metadata, requirements, and content/workflow hashes; secret values are never included." } },
      "/workflow-packages/validate": { post: { summary: "Validate a workflow package file without importing it (admin). Accepts {workflowPackage} or the raw package JSON and checks schema, source hash, content hash, and size limits." } },
      "/workflow-packages/preview": { post: { summary: "Preview importing a workflow package (admin). Accepts optional slug/targetSlug and returns the disabled workflow shape plus requirements report; no rows are written." } },
      "/workflow-packages/import": { post: { summary: "Import a workflow package file (admin). Publishes source as an immutable DB workflow bundle and upserts the workflow disabled by default for local configuration/preflight before enabling." } },
      "/schedules": {
        get: { summary: "List schedules (cron jobs) with next/last run and a human-readable preview" },
        post: { summary: "Create a schedule (admin). Body: {name, workflowSlug, cron|runAt, timezone, input, enabled}. Cron schedules fire recurringly; runAt fires once. Fires honor the workflow's approval policy." }
      },
      "/schedules/preview": { get: { summary: "Validate a cron expression (query: cron, timezone) and return a description plus the next fire times" } },
      "/schedules/{id}": {
        get: { summary: "Get a schedule" },
        patch: { summary: "Update a schedule (admin)" },
        delete: { summary: "Delete a schedule (admin)" }
      },
      "/schedules/{id}/enable": { post: { summary: "Enable a schedule (admin)" } },
      "/schedules/{id}/disable": { post: { summary: "Disable a schedule (admin)" } },
      "/schedules/{id}/run-now": { post: { summary: "Fire a schedule immediately without changing its cadence" } },
      "/runners/register": { post: { summary: "Register runner" } },
      "/runners/{id}/next-run": { get: { summary: "Claim next run for runner" } }
    }
  };
}
