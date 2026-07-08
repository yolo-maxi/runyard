import { API_GROUPS, openApiPathsFromSurface } from "./apiSurface.js";

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
  "get_schedule",
  "preview_schedule",
  "create_schedule",
  "update_schedule",
  "enable_schedule",
  "disable_schedule",
  "delete_schedule",
  "run_schedule_now",
  "download_artifact",
  "get_dashboard",
  "list_workflow_bundles",
  "get_workflow_bundle"
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
  lines.push("Tools (mirrors get_menu; the MCP server advertises the full set");
  lines.push("over tools/list):");
  for (const tool of HUB_TOOL_NAMES) lines.push(`- ${tool}`);
  lines.push("");
  lines.push("API-first guarantee: the web app is an ordinary client of the same");
  lines.push(`HTTP API. Every operation is documented in ${baseUrl}/openapi.json,`);
  lines.push("and everything the app can show or do is available over the API and");
  lines.push("MCP — a client built on those surfaces loses nothing.");
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
  lines.push("scopes (api, mcp, approvals, read, runner, admin); a token with only");
  lines.push("the read scope is read-only — it can inspect workflows, runs, logs,");
  lines.push("approvals, and schedules but cannot change anything. Ask this Hub's");
  lines.push("administrator for a token; admins issue them from the Connect tab in");
  lines.push("the web app (GET /api/tokens/scopes lists scopes and presets).");
  lines.push("");
  lines.push("API groups:");
  lines.push("- The API is organized into groups, exposed as OpenAPI tags:");
  lines.push("  workflows, runs, approvals, automation (schedules + endpoints),");
  lines.push("  library (agents, skills, knowledge, hooks), distribution (bundles,");
  lines.push("  packages), admin (tokens, secrets, audit, alerts, updates), and");
  lines.push("  system (health, version, menu, dashboard, runners).");
  lines.push("- Grouped operations also answer at stable /api/v1 aliases, e.g.");
  lines.push(`  ${baseUrl}/api/v1/automation/schedules or ${baseUrl}/api/v1/runs.`);
  lines.push("  Aliases share the canonical route's auth and scopes; unversioned");
  lines.push("  /api paths remain fully supported.");
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
  lines.push("Creating and editing workflows:");
  lines.push("- Workflows are stored in the Hub database as immutable, versioned");
  lines.push("  source bundles. Create or update them by sending workflow source");
  lines.push("  bytes through MCP (create_workflow / update_workflow), HTTP");
  lines.push("  (POST /api/workflows, PATCH /api/workflows/{id}), or by importing a");
  lines.push("  portable package file (see below).");
  lines.push("- Do NOT write workflow files to disk: custom workflows that reference");
  lines.push("  bare workflow.entry file paths without source bytes are rejected.");
  lines.push("  Repository-authored workflow files are reserved for the shipped");
  lines.push("  internal/dev seed catalog only.");
  lines.push("");
  lines.push("Schedules (cron and one-shot):");
  lines.push("- Schedules fire workflows on a recurring 5-field cron cadence");
  lines.push("  (with IANA timezone support) or once at an ISO runAt timestamp.");
  lines.push(`- HTTP lifecycle: GET/POST ${baseUrl}/api/schedules,`);
  lines.push("  GET /api/schedules/preview?cron=...&timezone=..., and per-schedule");
  lines.push("  GET/PATCH/DELETE /api/schedules/{id} plus");
  lines.push("  POST /api/schedules/{id}/enable | /disable | /run-now.");
  lines.push("- Equivalent MCP tools: list_schedules, get_schedule, preview_schedule,");
  lines.push("  create_schedule, update_schedule, enable_schedule, disable_schedule,");
  lines.push("  delete_schedule, run_schedule_now.");
  lines.push("- Each fire creates a normal run (origin.type \"schedule\", a");
  lines.push("  run.scheduled event, and last run status recorded on the schedule),");
  lines.push("  so scheduled runs are traced like any other run.");
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
        "Authenticate every request with `Authorization: Bearer shub_...`; tokens carry scopes (api, mcp, approvals, read, runner, admin) and the bootstrap token is full admin. " +
        "A token with only the read scope is read-only: it can inspect state but satisfies no create/update/delete/run/approve endpoint. " +
        "Operations are organized into groups — workflows, runs, approvals, automation, library, distribution, admin, system — exposed as the tags below. " +
        "Every grouped operation is also reachable at a stable /v1 alias (e.g. /v1/automation/schedules for /schedules); aliases share the canonical route's handler, auth, and scopes, and carry x-canonical-path. " +
        "Unversioned paths remain fully supported. Paths under /capabilities are deprecated legacy aliases of /workflows. " +
        "Typical flow: discover workflows (GET /menu or /workflows), start a run (POST /workflows/{id}/run with executionMode local|remote), then poll /runs/{id} and read /runs/{id}/timeline, /logs, and /artifacts. " +
        "Runs that need a human checkpoint enter waiting_approval and are resolved via /approvals/{id}/approve|reject|request-changes. " +
        "Liveness endpoints (/healthz, /readyz, /api/version) and discovery copy (/llms.txt, this document) are unauthenticated and served from the repo root, not under /api."
    },
    servers: [{ url: `${baseUrl}/api` }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    tags: Object.entries(API_GROUPS).map(([name, group]) => ({ name, description: group.description })),
    // Generated from the API surface registry (src/apiSurface.js) so this
    // document can never drift from the routes the server actually registers.
    paths: openApiPathsFromSurface()
  };
}
