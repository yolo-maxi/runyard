// MCP tool definitions for the runyard-mcp stdio server.
//
// This module is deliberately side-effect free so that mcp.js (the server),
// the API surface registry, and the parity tests can all import the same
// list. Every tool here must map to an operation in src/apiSurface.js and
// vice versa; tests/api-surface.test.js fails on drift in either direction.

export const MCP_TOOLS = [
  { name: "get_menu", description: "Show the Runyard menu: discovery steps, local vs remote execution choices, and Hub output/artifact follow-up paths.", inputSchema: { type: "object", properties: {} } },
  { name: "list_workflows", description: "List available RunYard workflows.", inputSchema: { type: "object", properties: {} } },
  { name: "search_workflows", description: "Search workflows by query.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_workflow", description: "Describe a workflow, schemas, permissions, skills, agents, and source configuration.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "get_workflow_source", description: "Get workflow source, parsed metadata, sections, and graph for a workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "list_workflow_versions", description: "List versions seen from previous runs for a workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  {
    name: "create_workflow",
    description: "Create a workflow definition. Requires an admin-scoped token. Custom workflows must include workflow source bytes (workflow.source/sourceBytes/code) or an existing workflow.bundleId; bare workflow.entry file paths are rejected unless explicitly trusted internal/dev.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: { type: "object", description: "Workflow definition payload." }
      }
    }
  },
  {
    name: "update_workflow",
    description: "Edit an existing workflow definition. Requires an admin-scoped token. Source updates must include workflow source bytes or an existing workflow.bundleId; bare workflow.entry file paths are rejected unless explicitly trusted internal/dev.",
    inputSchema: {
      type: "object",
      required: ["id", "workflow"],
      properties: {
        id: { type: "string" },
        workflow: { type: "object", description: "Partial workflow definition payload." }
      }
    }
  },
  {
    name: "delete_workflow",
    description: "Delete a workflow from the active catalog by disabling it. Historical runs remain intact. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
  },
  {
    name: "run_workflow",
    description: "Run a workflow with JSON input. For agent-created runs, include input.title when practical: a short human-readable title for run lists, approval cards, and handoff. Pass executionMode 'local' to target a local runner or 'remote' to target the shared remote/VPS runner pool. Outputs and artifacts are fetched from the Hub. For improve, input.repoDir selects an allowlisted runner-local git repo to edit. Optional budget { maxTokens, maxCostMicros } hard-caps the run's metered model usage; a breach terminates the run as budget_exceeded. Pass negotiate: true to preflight first — a non-ready request then returns the negotiation state (questions/blockers/warnings + a saved draft) instead of creating a run; fix the input and call again.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        input: { type: "object" },
        executionMode: { type: "string", enum: ["local", "remote", "auto"] },
        runnerLocation: { type: "string" },
        budget: {
          type: "object",
          description: "Optional hard spend ceiling for the run's metered model usage.",
          properties: {
            maxTokens: { type: "number", description: "Maximum total tokens across all metered model calls." },
            maxCostMicros: { type: "number", description: "Maximum cost in micro-USD (1000000 = $1)." }
          }
        },
        negotiate: { type: "boolean" },
        workItemId: { type: "string", description: "Optional work item (ticket) id to attach the run to; the run then appears on that ticket's board card and detail." }
      }
    }
  },
  {
    name: "preflight_workflow",
    description: "Dry-run the deterministic run-creation preflight for a workflow with JSON input. Returns ready | needs_input | blocked with questions, blockers, warnings, suggested defaults, and the normalized input — nothing is created or enqueued. Use before run_workflow when the input is rough or unverified. An invalid budget or incomplete gateway-metering selection surfaces here as blockers.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        input: { type: "object" },
        executionMode: { type: "string", enum: ["local", "remote", "auto"] },
        runnerLocation: { type: "string" },
        budget: {
          type: "object",
          description: "Optional hard spend ceiling to validate.",
          properties: {
            maxTokens: { type: "number" },
            maxCostMicros: { type: "number" }
          }
        }
      }
    }
  },
  { name: "export_workflow_package", description: "Export a workflow as an immutable .runyard-workflow.json package. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "validate_workflow_package", description: "Validate a .runyard-workflow.json package before import. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" } } } },
  { name: "preview_workflow_import", description: "Preview importing a .runyard-workflow.json package without installing it. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" }, slug: { type: "string" } } } },
  { name: "import_workflow_package", description: "Import a .runyard-workflow.json package as a disabled workflow draft. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" }, slug: { type: "string" } } } },
  { name: "list_run_drafts", description: "List negotiated workflow run drafts.", inputSchema: { type: "object", properties: { status: { type: "string" }, workflow: { type: "string" } } } },
  { name: "get_run_draft", description: "Inspect a negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "create_run_draft", description: "Create a negotiated workflow run draft and run deterministic preflight. A spend budget rides the input as input.budget ({ maxTokens, maxCostMicros }) and is validated by preflight.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" } } } },
  { name: "update_run_draft", description: "Edit a negotiated workflow run draft and re-run preflight. A spend budget rides the input as input.budget ({ maxTokens, maxCostMicros }).", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" } } } },
  { name: "submit_run_draft", description: "Submit a ready negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "discard_run_draft", description: "Discard a negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "list_runs", description: "List workflow runs with optional status/query/workflow filters.", inputSchema: { type: "object", properties: { status: { type: "string" }, query: { type: "string" }, workflow: { type: "string" }, limit: { type: "number" } } } },
  { name: "list_attention_runs", description: "The operator triage queue: runs whose next step is a human action — paused runs (resume with resume_run), runs waiting for approval (decide via their approval card), and runs stopped at their budget in the last 7 days (raise the budget and rerun_workflow_run) — plus counts including pending approval cards. Answers \"is anything silently stuck?\" in one call.", inputSchema: { type: "object", properties: {} } },
  { name: "get_usage_summary", description: "Cross-run metered usage rollup for a time window (days, default 30, max 365): fleet totals (totalTokens, costMicros, calls, meteredRuns), a per-workflow breakdown sorted by spend, and how many runs stopped at their budget in the window. Use get_run_usage for a single run's detail.", inputSchema: { type: "object", properties: { days: { type: "number", description: "Window size in days (1-365, default 30)." } } } },
  { name: "get_run_status", description: "Get run status and summary, including metered usage totals (run.usage: tokens/costMicros/byModel) and the run budget when set.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_events", description: "Get structured events for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_timeline", description: "Get normalized timeline entries for a run. Pass since (the nextSince value from a previous call) to page forward.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, since: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_run_flow", description: "Get a run's execution flow: the workflow's static step graph with this run's events folded on — one state per step (pending/active/done/failed/waiting/cancelled/skipped), timings, and pending approvals. Answers \"where is this run in its workflow?\".", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_usage", description: "Get a run's metered model-call usage: aggregate totals (totalTokens, costMicros, byModel, byProvider), the optional budget, per-call usage records, and budgetStop when the run was terminated on its budget.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_diagnostics", description: "Get diagnostics and log summary for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_logs", description: "Get run event log text.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_artifacts", description: "List artifacts for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "download_artifact", description: "Download an artifact's content by artifact id (from get_run_artifacts or search_artifacts). Text artifacts return their content directly; binary artifacts return base64 with the mime type noted.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: { type: "string" } } } },
  { name: "rerun_workflow_run", description: "Create a linked rerun from a previous run, optionally overriding input. The rerun inherits the previous run's budget unless budget/input.budget overrides it.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" }, budget: { type: "object", description: "Optional hard spend ceiling ({ maxTokens, maxCostMicros }).", properties: { maxTokens: { type: "number" }, maxCostMicros: { type: "number" } } } } } },
  { name: "promote_run", description: "Promote a successful run's mutation/artifact according to server policy.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, note: { type: "string" } } } },
  { name: "list_runners", description: "List registered runners, heartbeat state, capacity, active slots, and pool summary.", inputSchema: { type: "object", properties: {} } },
  { name: "whoami", description: "Show the authenticated identity: token name and granted scopes.", inputSchema: { type: "object", properties: {} } },
  { name: "list_schedules", description: "List scheduled workflow runs (cron or one-shot), including next fire times.", inputSchema: { type: "object", properties: {} } },
  { name: "get_schedule", description: "Inspect a schedule: workflow, cron/runAt, timezone, input, enabled state, and recent fire result.", inputSchema: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string" } } } },
  { name: "preview_schedule", description: "Preview a cron expression: human description and next fire times in the given timezone. Nothing is created.", inputSchema: { type: "object", required: ["cron"], properties: { cron: { type: "string" }, timezone: { type: "string" } } } },
  {
    name: "create_schedule",
    description: "Create a schedule that runs a workflow on a cron cadence or once at runAt. Requires an admin-scoped token.",
    inputSchema: {
      type: "object",
      required: ["name", "workflow"],
      properties: {
        name: { type: "string" },
        workflow: { type: "string", description: "Workflow slug to run." },
        cron: { type: "string", description: "Cron expression (5 fields). Provide cron or runAt." },
        runAt: { type: "string", description: "ISO timestamp for a one-shot run. Provide cron or runAt." },
        timezone: { type: "string" },
        input: { type: "object", description: "Workflow input for each fire." },
        description: { type: "string" },
        enabled: { type: "boolean" }
      }
    }
  },
  {
    name: "update_schedule",
    description: "Edit a schedule (any subset of name, workflow, cron, runAt, timezone, input, description, enabled). Requires an admin-scoped token.",
    inputSchema: {
      type: "object",
      required: ["scheduleId"],
      properties: {
        scheduleId: { type: "string" },
        name: { type: "string" },
        workflow: { type: "string" },
        cron: { type: "string" },
        runAt: { type: "string" },
        timezone: { type: "string" },
        input: { type: "object" },
        description: { type: "string" },
        enabled: { type: "boolean" }
      }
    }
  },
  { name: "enable_schedule", description: "Enable a schedule so it fires on its cadence again. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string" } } } },
  { name: "disable_schedule", description: "Disable a schedule without deleting it; it keeps its definition but stops firing. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string" } } } },
  { name: "delete_schedule", description: "Delete a schedule. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string" } } } },
  { name: "run_schedule_now", description: "Fire a schedule immediately, creating a run outside its normal cadence. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string" } } } },
  { name: "list_work_items", description: "List work items (tickets) on the company work board, each with a linked-run rollup (total, byStatus, attention count). Filters: status (intake|triaged|ready|running|waiting|blocked|review|shipped|accepted|archived), project, owner, type, query. Archived items are hidden unless includeArchived is true.", inputSchema: { type: "object", properties: { status: { type: "string" }, project: { type: "string" }, owner: { type: "string" }, type: { type: "string" }, query: { type: "string" }, includeArchived: { type: "boolean" }, limit: { type: "number" } } } },
  { name: "get_work_item", description: "Get a work item (ticket) with its linked runs, their approvals and artifacts, and the ticket history (status moves, run links, edits).", inputSchema: { type: "object", required: ["workItemId"], properties: { workItemId: { type: "string" } } } },
  {
    name: "create_work_item",
    description: "Create a work item (ticket): the durable unit of company work, distinct from workflows (recipes) and runs (execution attempts). Give it a clear title and, when known, acceptance criteria and a next action. Statuses: intake, triaged, ready, running, waiting, blocked, review, shipped, accepted, archived.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string", description: "What we are trying to do and why." },
        project: { type: "string" },
        type: { type: "string", enum: ["feature", "bug", "research", "release", "maintenance", "idea"] },
        status: { type: "string", enum: ["intake", "triaged", "ready", "running", "waiting", "blocked", "review", "shipped", "accepted", "archived"] },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
        owner: { type: "string" },
        requester: { type: "string" },
        acceptanceCriteria: { type: "string", description: "How we will know the ask is satisfied." },
        nextAction: { type: "string", description: "The single next concrete action." },
        dueAt: { type: "string", description: "Optional ISO due/target date." }
      }
    }
  },
  {
    name: "update_work_item",
    description: "Update a work item (ticket): edit fields or move it across the board by setting status. A failed run never moves a ticket by itself — park it in blocked/waiting/review here with blockedReason/nextAction explaining the human-legible next step.",
    inputSchema: {
      type: "object",
      required: ["workItemId"],
      properties: {
        workItemId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        project: { type: "string" },
        type: { type: "string", enum: ["feature", "bug", "research", "release", "maintenance", "idea"] },
        status: { type: "string", enum: ["intake", "triaged", "ready", "running", "waiting", "blocked", "review", "shipped", "accepted", "archived"] },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
        owner: { type: "string" },
        requester: { type: "string" },
        acceptanceCriteria: { type: "string" },
        nextAction: { type: "string" },
        blockedReason: { type: "string", description: "Why the ticket cannot progress; set when moving to blocked." },
        dueAt: { type: "string" }
      }
    }
  },
  { name: "delete_work_item", description: "Delete a work item (ticket). Linked runs survive unlinked; prefer update_work_item with status 'archived' to keep ticket history. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workItemId"], properties: { workItemId: { type: "string" } } } },
  { name: "link_work_item_run", description: "Link an existing run to a work item (ticket). A run belongs to at most one ticket; relinking moves it. To link at creation time instead, pass workItemId to run_workflow.", inputSchema: { type: "object", required: ["workItemId", "runId"], properties: { workItemId: { type: "string" }, runId: { type: "string" } } } },
  { name: "unlink_work_item_run", description: "Unlink a run from a work item (ticket).", inputSchema: { type: "object", required: ["workItemId", "runId"], properties: { workItemId: { type: "string" }, runId: { type: "string" } } } },
  { name: "list_boards", description: "List boards: durable configured views over work items (lane definitions, project scope, default workflow suggestions, and lane-enter triggers). One board is the instance default — usually the deployment's own software-factory board.", inputSchema: { type: "object", properties: {} } },
  { name: "get_board", description: "Get one board with its lane definitions, lane-enter triggers, per-lane ticket counts, and the decorated work items in its scope — the whole factory picture in one call.", inputSchema: { type: "object", required: ["boardSlug"], properties: { boardSlug: { type: "string" }, includeArchived: { type: "boolean" } } } },
  {
    name: "create_board",
    description: "Create a board: a configured view over work items for a product/infra/docs/release train. Lanes default to the standard seven-column factory layout; project scopes membership ('' = all work items). Lanes may include trigger {mode: none|suggest|confirm|auto, workflow?, label?, description?, input?}.",
    inputSchema: {
      type: "object",
      required: ["slug", "title"],
      properties: {
        slug: { type: "string", description: "Lowercase letters/digits/hyphens." },
        title: { type: "string" },
        description: { type: "string" },
        project: { type: "string", description: "Scope the board to one project ('' = all work items)." },
        lanes: { type: "array", description: "Lane definitions [{id, label, hint?, empty?, statuses[], trigger?}]; trigger mode suggest only nudges, confirm asks before launching, auto launches from config.", items: { type: "object" } },
        defaultWorkflows: { type: "array", description: "Workflow slugs suggested for launching from this board's tickets.", items: { type: "string" } },
        isDefault: { type: "boolean" }
      }
    }
  },
  {
    name: "update_board",
    description: "Update a board's title, description, project scope, lane definitions/triggers, defaultWorkflows, or isDefault. Slug is immutable.",
    inputSchema: {
      type: "object",
      required: ["boardSlug"],
      properties: {
        boardSlug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        project: { type: "string" },
        lanes: { type: "array", items: { type: "object" } },
        defaultWorkflows: { type: "array", items: { type: "string" } },
        isDefault: { type: "boolean" }
      }
    }
  },
  { name: "list_repo_options", description: "List allowlisted repos/projects this Hub can target without exposing raw paths.", inputSchema: { type: "object", properties: {} } },
  { name: "list_workflow_endpoints", description: "List fixed-purpose authenticated workflow endpoints. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "get_workflow_endpoint", description: "Inspect a fixed-purpose authenticated workflow endpoint. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["endpointSlug"], properties: { endpointSlug: { type: "string" } } } },
  { name: "upsert_workflow_endpoint", description: "Create or edit a fixed-purpose authenticated workflow endpoint. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "object" } } } },
  { name: "submit_workflow_endpoint", description: "Submit payload to a fixed-purpose workflow endpoint using that endpoint's secret.", inputSchema: { type: "object", required: ["endpointSlug"], properties: { endpointSlug: { type: "string" }, payload: { type: "object" }, secret: { type: "string" } } } },
  { name: "list_tokens", description: "List Hub access tokens. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "list_token_scopes", description: "Describe the token scope vocabulary and presets (everything, read-only, approvals-only, runner, admin): what each scope grants and the default scopes. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "create_token", description: "Create a Hub access token. Requires an admin-scoped token. Scopes: api, mcp, approvals, read (read-only), runner, admin — call list_token_scopes for what each grants and the named presets.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" }, description: "Token scopes; defaults to [\"api\",\"mcp\"]. Use [\"read\"] for a read-only token." }, expiresInDays: { type: "number", description: "Days until the token expires. Omit for a non-expiring token." } } } },
  { name: "revoke_token", description: "Revoke a Hub access token. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["tokenId"], properties: { tokenId: { type: "string" } } } },
  { name: "list_secrets", description: "List configured secret names and metadata, never values. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "set_secret", description: "Create or update an encrypted secret value. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: { type: "string" }, description: { type: "string" } } } },
  { name: "delete_secret", description: "Delete an encrypted secret. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } },
  { name: "list_pending_approvals", description: "List pending approval cards. Each item carries its ask (who is asked, what approving does, why a human is needed), kind, deadline/fallback, and deep links; resolve one with approve_run / reject_run / request_changes_run using its approvalId.", inputSchema: { type: "object", properties: {} } },
  { name: "list_approvals", description: "List approval cards. Pass status 'pending' or 'resolved' to filter; omit it for recent history. Resolved cards carry the decision in their resolution field (approved | rejected | changes_requested).", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "resolved"] } } } },
  { name: "get_approval", description: "Inspect a single approval card by approvalId: ask, kind, status, resolution, and linked run.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" } } } },
  {
    name: "create_approval",
    description: "Raise an approval card for a human decision. Use ask to say who is asked, what approving does, and why a human is needed. Optional timeoutMs/timeoutAt with fallback ('approve' | 'reject') makes it a timed approval.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        runId: { type: "string", description: "Run to hold on this approval, if any." },
        ask: { type: "object", description: "Ask contract: { action, reason, audience }." },
        payload: { type: "object" },
        timeoutMs: { type: "number" },
        timeoutAt: { type: "string" },
        fallback: { type: "string" }
      }
    }
  },
  {
    name: "list_hooks",
    description: "List post-run hook profiles (optional side effects like static publish or git push, run after a workflow's gates pass). Pass workflow to see which profiles that workflow may select via input.postRunHooks.",
    inputSchema: { type: "object", properties: { workflow: { type: "string" } } }
  },
  { name: "get_hook", description: "Inspect a post-run hook profile: config, allowed workflows, and validation state.", inputSchema: { type: "object", required: ["hookSlug"], properties: { hookSlug: { type: "string" } } } },
  { name: "upsert_hook", description: "Create or edit a post-run hook profile. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["hook"], properties: { hook: { type: "object", description: "Hook profile payload including slug." } } } },
  { name: "validate_hook", description: "Validate a post-run hook profile's configuration without running it. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["hookSlug"], properties: { hookSlug: { type: "string" } } } },
  { name: "get_audit_log", description: "Read the Hub audit trail (who did what, most recent first). Requires an admin-scoped token.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "list_alerts", description: "List failure alerts recorded by the Hub. Requires an admin-scoped token.", inputSchema: { type: "object", properties: { kind: { type: "string" }, limit: { type: "number" } } } },
  { name: "approve_run", description: "Resolve a Hub approval card as approved (takes an approvalId from list_pending_approvals, not a runId). What happens next depends on the card's kind: a held run is released, an engine gate resumes on the runner, an escalation records the go-ahead.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "reject_run", description: "Resolve a Hub approval card as rejected (takes an approvalId, not a runId). A run held on the card is cancelled — never failed; an engine gate takes its deny path.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "request_changes_run", description: "Resolve a Hub approval card as changes_requested (takes an approvalId, not a runId). Use comment to describe the changes; a run held on the card is cancelled so it can be re-run with new input.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "cancel_run", description: "Cancel a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, reason: { type: "string" } } } },
  { name: "pause_run", description: "Pause an active run for a recoverable interruption (e.g. credits_exhausted, quota_exhausted, manual). A paused run keeps its engine checkpoint, frees its runner slot, is never reaped, and can be resumed with resume_run or cancelled.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, reason: { type: "string", description: "Pause reason, e.g. credits_exhausted, quota_exhausted, manual." }, message: { type: "string" } } } },
  { name: "resume_run", description: "Resume a paused run: re-queues the same run and continues from the recorded engine checkpoint when one exists; otherwise it re-runs from scratch (the response's resume.strategy says which). A checkpointed resume runs on the runner holding the checkpoint — the response warns if that runner is offline. Pass strategy 'rerun_from_scratch' to discard the checkpoint and let any runner take it.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, strategy: { type: "string", enum: ["smithers_resume", "rerun_from_scratch"], description: "Force a resume strategy. Omit for automatic: checkpointed when a checkpoint is recorded, from scratch otherwise. 'rerun_from_scratch' discards the checkpoint and clears the runner pin; 'smithers_resume' errors if no checkpoint is recorded." } } } },
  { name: "search_artifacts", description: "Search artifacts.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "list_agents", description: "List reusable Hub agents.", inputSchema: { type: "object", properties: {} } },
  { name: "list_skills", description: "List reusable Hub skills.", inputSchema: { type: "object", properties: {} } },
  { name: "search_knowledge", description: "Search Hub knowledge resources.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  {
    name: "create_agent",
    description: "Create a reusable Hub agent role. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["agent"], properties: { agent: { type: "object", description: "Agent definition including slug." } } }
  },
  {
    name: "update_agent",
    description: "Update a reusable Hub agent role by slug. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["slug", "agent"], properties: { slug: { type: "string" }, agent: { type: "object", description: "Agent definition fields to set." } } }
  },
  {
    name: "create_skill",
    description: "Create a reusable Hub skill. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["skill"], properties: { skill: { type: "object", description: "Skill definition including slug." } } }
  },
  {
    name: "update_skill",
    description: "Update a reusable Hub skill by slug. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["slug", "skill"], properties: { slug: { type: "string" }, skill: { type: "object", description: "Skill definition fields to set." } } }
  },
  {
    name: "create_knowledge",
    description: "Create a Hub knowledge resource. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["knowledge"], properties: { knowledge: { type: "object", description: "Knowledge resource definition including slug." } } }
  },
  {
    name: "update_knowledge",
    description: "Update a Hub knowledge resource by slug. Requires an admin-scoped token.",
    inputSchema: { type: "object", required: ["slug", "knowledge"], properties: { slug: { type: "string" }, knowledge: { type: "object", description: "Knowledge resource fields to set." } } }
  },
  { name: "get_dashboard", description: "Get the Hub dashboard summary: run counts by status, recent activity, and attention items (the same data the web Home header shows).", inputSchema: { type: "object", properties: {} } },
  {
    name: "list_workflow_bundles",
    description: "List immutable workflow source bundles stored in the Hub DB (id, workflow slug, version, size, sha256 — never source bytes). Pass workflow to filter by slug.",
    inputSchema: { type: "object", properties: { workflow: { type: "string", description: "Workflow slug to filter by." } } }
  },
  {
    name: "get_workflow_bundle",
    description: "Get a workflow source bundle by bundle id, including its source code.",
    inputSchema: { type: "object", required: ["bundleId"], properties: { bundleId: { type: "string" } } }
  },
  {
    name: "publish_workflow_bundle",
    description: "Publish workflow source bytes as a new immutable bundle version for a workflow slug. Requires an admin-scoped token. Prefer create_workflow/update_workflow with inline source, which publish a bundle for you.",
    inputSchema: {
      type: "object",
      required: ["workflow", "code"],
      properties: {
        workflow: { type: "string", description: "Workflow slug the bundle belongs to." },
        code: { type: "string", description: "Workflow source bytes." },
        language: { type: "string", description: "Source language, e.g. tsx or js." }
      }
    }
  },
  { name: "get_update_status", description: "Report whether a newer Hub release is available and the current self-update state. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "apply_update", description: "Apply the available Hub self-update. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "get_assistant_status", description: "In-app Assistant status: resolved provider (runner|anthropic|openai) and whether it is configured.", inputSchema: { type: "object", properties: {} } },
  {
    name: "ask_assistant",
    description: "Ask the Hub's in-app Assistant a question about this deployment. Body mirrors the web app's chat: messages is an array of {role, content}. Answers first; any app-changing action is returned as a proposal, never executed server-side.",
    inputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        messages: { type: "array", items: { type: "object" }, description: "Chat turns: [{role: 'user'|'assistant', content: string}, ...]" },
        context: { type: "object", description: "Optional context (e.g. current view)." }
      }
    }
  }
];
