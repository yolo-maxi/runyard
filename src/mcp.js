#!/usr/bin/env node
import { HubClient } from "./apiClient.js";
import { resolveRemote } from "./config.js";
import { resolveHubUrl, resolveHubToken } from "./hubConnection.js";
import { packageVersion as mcpVersion } from "./packageInfo.js";

// Resolve target hub from (in order): env, --remote <name> in argv, the current saved remote.
const remoteArgIndex = process.argv.indexOf("--remote");
const remoteName = remoteArgIndex >= 0 ? process.argv[remoteArgIndex + 1] : null;
const remote = resolveRemote(remoteName);
const client = new HubClient({
  baseUrl: resolveHubUrl({ remote }),
  token: resolveHubToken({ remote })
});

const tools = [
  { name: "get_menu", description: "Show the Runyard menu: discovery steps, local vs remote execution choices, and Hub output/artifact follow-up paths.", inputSchema: { type: "object", properties: {} } },
  { name: "list_workflows", description: "List available RunYard workflows.", inputSchema: { type: "object", properties: {} } },
  { name: "search_workflows", description: "Search workflows by query.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_workflow", description: "Describe a workflow, schemas, permissions, skills, agents, and source configuration.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "get_workflow_source", description: "Get workflow source, parsed metadata, sections, and graph for a workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "list_workflow_versions", description: "List versions seen from previous runs for a workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  {
    name: "create_workflow",
    description: "Create a workflow definition. Requires an admin-scoped token. Body should include name, optional slug/description/category/schema fields, runner requirements, approval policy, and workflow source reference.",
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
    description: "Edit an existing workflow definition. Requires an admin-scoped token. The slug/id is stable; payload fields are merged into the existing definition.",
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
    description: "Run a workflow with JSON input. For agent-created runs, include input.title when practical: a short human-readable title for run lists, approval cards, and handoff. Pass executionMode 'local' to target a local runner or 'remote' to target the shared remote/VPS runner pool. Outputs and artifacts are fetched from the Hub. For improve, input.repoDir selects an allowlisted runner-local git repo to edit. Pass negotiate: true to preflight first — a non-ready request then returns the negotiation state (questions/blockers/warnings + a saved draft) instead of creating a run; fix the input and call again.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        input: { type: "object" },
        executionMode: { type: "string", enum: ["local", "remote", "auto"] },
        runnerLocation: { type: "string" },
        negotiate: { type: "boolean" }
      }
    }
  },
  {
    name: "preflight_workflow",
    description: "Dry-run the deterministic run-creation preflight for a workflow with JSON input. Returns ready | needs_input | blocked with questions, blockers, warnings, suggested defaults, and the normalized input — nothing is created or enqueued. Use before run_workflow when the input is rough or unverified.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        input: { type: "object" },
        executionMode: { type: "string", enum: ["local", "remote", "auto"] },
        runnerLocation: { type: "string" }
      }
    }
  },
  { name: "export_workflow_package", description: "Export a workflow as an immutable .runyard-workflow.json package. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "validate_workflow_package", description: "Validate a .runyard-workflow.json package before import. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" } } } },
  { name: "preview_workflow_import", description: "Preview importing a .runyard-workflow.json package without installing it. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" }, slug: { type: "string" } } } },
  { name: "import_workflow_package", description: "Import a .runyard-workflow.json package as a disabled workflow draft. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["workflowPackage"], properties: { workflowPackage: { type: "object" }, slug: { type: "string" } } } },
  { name: "list_run_drafts", description: "List negotiated workflow run drafts.", inputSchema: { type: "object", properties: { status: { type: "string" }, workflow: { type: "string" } } } },
  { name: "get_run_draft", description: "Inspect a negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "create_run_draft", description: "Create a negotiated workflow run draft and run deterministic preflight.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" } } } },
  { name: "update_run_draft", description: "Edit a negotiated workflow run draft and re-run preflight.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" } } } },
  { name: "submit_run_draft", description: "Submit a ready negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "discard_run_draft", description: "Discard a negotiated workflow run draft.", inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } } },
  { name: "list_runs", description: "List workflow runs with optional status/query/workflow filters.", inputSchema: { type: "object", properties: { status: { type: "string" }, query: { type: "string" }, workflow: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_run_status", description: "Get run status and summary.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_events", description: "Get structured events for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_timeline", description: "Get normalized timeline entries for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, cursor: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_run_diagnostics", description: "Get diagnostics and log summary for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_logs", description: "Get run event log text.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_artifacts", description: "List artifacts for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "rerun_workflow_run", description: "Create a linked rerun from a previous run, optionally overriding input.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, input: { type: "object" }, executionMode: { type: "string", enum: ["local", "remote", "auto"] }, runnerLocation: { type: "string" } } } },
  { name: "promote_run", description: "Promote a successful run's mutation/artifact according to server policy.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, note: { type: "string" } } } },
  { name: "list_runners", description: "List registered runners, heartbeat state, capacity, active slots, and pool summary.", inputSchema: { type: "object", properties: {} } },
  { name: "list_repo_options", description: "List allowlisted repos/projects this Hub can target without exposing raw paths.", inputSchema: { type: "object", properties: {} } },
  { name: "list_workflow_endpoints", description: "List fixed-purpose authenticated workflow endpoints. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "get_workflow_endpoint", description: "Inspect a fixed-purpose authenticated workflow endpoint. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["endpointSlug"], properties: { endpointSlug: { type: "string" } } } },
  { name: "upsert_workflow_endpoint", description: "Create or edit a fixed-purpose authenticated workflow endpoint. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "object" } } } },
  { name: "submit_workflow_endpoint", description: "Submit payload to a fixed-purpose workflow endpoint using that endpoint's secret.", inputSchema: { type: "object", required: ["endpointSlug"], properties: { endpointSlug: { type: "string" }, payload: { type: "object" }, secret: { type: "string" } } } },
  { name: "list_tokens", description: "List Hub access tokens. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "create_token", description: "Create a Hub access token. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } } },
  { name: "revoke_token", description: "Revoke a Hub access token. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["tokenId"], properties: { tokenId: { type: "string" } } } },
  { name: "list_secrets", description: "List configured secret names and metadata, never values. Requires an admin-scoped token.", inputSchema: { type: "object", properties: {} } },
  { name: "set_secret", description: "Create or update an encrypted secret value. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: { type: "string" } } } },
  { name: "delete_secret", description: "Delete an encrypted secret. Requires an admin-scoped token.", inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } },
  { name: "list_pending_approvals", description: "List pending approval cards. Each item carries its ask (who is asked, what approving does, why a human is needed), kind, deadline/fallback, and deep links; resolve one with approve_run / reject_run / request_changes_run using its approvalId.", inputSchema: { type: "object", properties: {} } },
  {
    name: "list_hooks",
    description: "List post-run hook profiles (optional side effects like static publish or git push, run after a workflow's gates pass). Pass workflow to see which profiles that workflow may select via input.postRunHooks.",
    inputSchema: { type: "object", properties: { workflow: { type: "string" } } }
  },
  { name: "approve_run", description: "Resolve a Hub approval card as approved (takes an approvalId from list_pending_approvals, not a runId). What happens next depends on the card's kind: a held run is released, an engine gate resumes on the runner, an escalation records the go-ahead.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "reject_run", description: "Resolve a Hub approval card as rejected (takes an approvalId, not a runId). A run held on the card is cancelled — never failed; an engine gate takes its deny path.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "request_changes_run", description: "Resolve a Hub approval card as changes_requested (takes an approvalId, not a runId). Use comment to describe the changes; a run held on the card is cancelled so it can be re-run with new input.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "cancel_run", description: "Cancel a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, reason: { type: "string" } } } },
  { name: "search_artifacts", description: "Search artifacts.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "list_agents", description: "List reusable Hub agents.", inputSchema: { type: "object", properties: {} } },
  { name: "list_skills", description: "List reusable Hub skills.", inputSchema: { type: "object", properties: {} } },
  { name: "search_knowledge", description: "Search Hub knowledge resources.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }
];

function result(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

function workflowId(args = {}) {
  return args.id || args.workflow || args.capability || args.slug;
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

async function callTool(name, args = {}) {
  if (name === "get_menu") return result(await client.get("/api/menu"));
  if (name === "list_workflows" || name === "list_capabilities") return result(await client.get("/api/workflows"));
  if (name === "search_workflows" || name === "search_capabilities") return result(await client.get(`/api/workflows?q=${encodeURIComponent(args.query || "")}`));
  if (name === "describe_workflow" || name === "describe_capability") return result(await client.get(`/api/workflows/${encodeURIComponent(workflowId(args))}`));
  if (name === "get_workflow_source" || name === "get_capability_source") return result(await client.get(`/api/workflows/${encodeURIComponent(workflowId(args))}/source`));
  if (name === "list_workflow_versions" || name === "list_capability_versions") return result(await client.get(`/api/workflows/${encodeURIComponent(workflowId(args))}/versions`));
  if (name === "create_workflow") return result(await client.post("/api/workflows", args.workflow || args.definition || args));
  if (name === "update_workflow") return result(await client.patch(`/api/workflows/${encodeURIComponent(workflowId(args))}`, args.workflow || args.patch || args));
  if (name === "delete_workflow") return result(await client.delete(`/api/workflows/${encodeURIComponent(workflowId(args))}`));
  if (name === "run_workflow" || name === "run_capability") {
    try {
      return result(await client.post(`/api/workflows/${encodeURIComponent(workflowId(args))}/run`, {
        input: args.input || {},
        executionMode: args.executionMode || args.where || undefined,
        runnerLocation: args.runnerLocation || undefined,
        ...(args.negotiate === true ? { negotiate: true } : {}),
        origin: {
          type: "mcp",
          label: "MCP: runyard",
          tool: "run_workflow"
        }
      }));
    } catch (error) {
      // Negotiate mode reports non-ready preflight as structured 422/409
      // bodies; surface them as tool output so the agent can answer the
      // questions and retry, instead of a bare protocol error.
      if (args.negotiate === true && error.response?.negotiation) return result(error.response);
      throw error;
    }
  }
  if (name === "preflight_workflow" || name === "preflight_capability") {
    return result(await client.post(`/api/workflows/${encodeURIComponent(workflowId(args))}/preflight`, {
      input: args.input || {},
      executionMode: args.executionMode || args.where || undefined,
      runnerLocation: args.runnerLocation || undefined
    }));
  }
  if (name === "export_workflow_package") return result(await client.get(`/api/workflow-packages/workflows/${encodeURIComponent(workflowId(args))}/export`));
  if (name === "validate_workflow_package") return result(await client.post("/api/workflow-packages/validate", { workflowPackage: args.workflowPackage || args.package || args }));
  if (name === "preview_workflow_import") return result(await client.post("/api/workflow-packages/preview", { workflowPackage: args.workflowPackage || args.package || args, slug: args.slug || "" }));
  if (name === "import_workflow_package") return result(await client.post("/api/workflow-packages/import", { workflowPackage: args.workflowPackage || args.package || args, slug: args.slug || "" }));
  if (name === "list_run_drafts") return result(await client.get(`/api/run-drafts${queryString({ status: args.status, workflow: args.workflow || args.capability })}`));
  if (name === "get_run_draft") return result(await client.get(`/api/run-drafts/${encodeURIComponent(args.draftId || args.id)}`));
  if (name === "create_run_draft") return result(await client.post("/api/run-drafts", {
    workflow: workflowId(args),
    capability: workflowId(args),
    input: args.input || {},
    executionMode: args.executionMode || args.where || undefined,
    runnerLocation: args.runnerLocation || undefined
  }));
  if (name === "update_run_draft") return result(await client.patch(`/api/run-drafts/${encodeURIComponent(args.draftId || args.id)}`, {
    input: args.input || undefined,
    executionMode: args.executionMode || args.where || undefined,
    runnerLocation: args.runnerLocation || undefined
  }));
  if (name === "submit_run_draft") return result(await client.post(`/api/run-drafts/${encodeURIComponent(args.draftId || args.id)}/submit`, {}));
  if (name === "discard_run_draft") return result(await client.post(`/api/run-drafts/${encodeURIComponent(args.draftId || args.id)}/discard`, {}));
  if (name === "list_runs") return result(await client.get(`/api/runs${queryString({
    status: args.status,
    q: args.query || args.q,
    workflow: args.workflow || args.capability,
    capability: args.workflow || args.capability,
    limit: args.limit
  })}`));
  if (name === "get_run_status") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}`));
  if (name === "get_run_events") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/events`));
  if (name === "get_run_timeline") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/timeline${queryString({ cursor: args.cursor, limit: args.limit })}`));
  if (name === "get_run_diagnostics") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/diagnostics`));
  if (name === "get_run_logs") {
    const response = await fetch(`${client.baseUrl}/api/runs/${encodeURIComponent(args.runId)}/logs`, { headers: { authorization: `Bearer ${client.token}` } });
    return result(await response.text());
  }
  if (name === "get_run_artifacts") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/artifacts`));
  if (name === "rerun_workflow_run" || name === "rerun_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/rerun`, {
    input: args.input || undefined,
    executionMode: args.executionMode || args.where || undefined,
    runnerLocation: args.runnerLocation || undefined
  }));
  if (name === "promote_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/promote`, { note: args.note || "" }));
  if (name === "list_runners") return result(await client.get("/api/runners"));
  if (name === "list_repo_options") return result(await client.get("/api/repo-options"));
  if (name === "list_workflow_endpoints") return result(await client.get("/api/workflow-endpoints"));
  if (name === "get_workflow_endpoint") return result(await client.get(`/api/workflow-endpoints/${encodeURIComponent(args.endpointSlug || args.slug)}`));
  if (name === "upsert_workflow_endpoint") return result(await client.post("/api/workflow-endpoints", args.endpoint || args));
  if (name === "submit_workflow_endpoint") {
    const headers = { authorization: `Bearer ${client.token}`, "content-type": "application/json" };
    if (args.secret) headers["x-runyard-endpoint-secret"] = args.secret;
    const response = await fetch(`${client.baseUrl}/api/workflow-endpoints/${encodeURIComponent(args.endpointSlug || args.slug)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args.payload || {})
    });
    return result(await response.json());
  }
  if (name === "list_tokens") return result(await client.get("/api/tokens"));
  if (name === "create_token") return result(await client.post("/api/tokens", { name: args.name, scopes: args.scopes || ["api", "mcp"] }));
  if (name === "revoke_token") return result(await client.delete(`/api/tokens/${encodeURIComponent(args.tokenId || args.id)}`));
  if (name === "list_secrets") return result(await client.get("/api/secrets"));
  if (name === "set_secret") return result(await client.put(`/api/secrets/${encodeURIComponent(args.key)}`, { value: args.value }));
  if (name === "delete_secret") return result(await client.delete(`/api/secrets/${encodeURIComponent(args.key)}`));
  if (name === "list_pending_approvals") return result(await client.get("/api/approvals?status=pending"));
  if (name === "list_hooks") {
    const slug = args.workflow || args.capability;
    return result(await client.get(`/api/hooks${slug ? `?workflow=${encodeURIComponent(slug)}` : ""}`));
  }
  if (name === "approve_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/approve`, { comment: args.comment || "Approved through MCP" }));
  if (name === "reject_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/reject`, { comment: args.comment || "Rejected through MCP" }));
  if (name === "request_changes_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/request-changes`, { comment: args.comment || "Changes requested through MCP" }));
  if (name === "cancel_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/cancel`, { reason: args.reason || "Cancelled through MCP" }));
  if (name === "search_artifacts") return result(await client.get(`/api/artifacts?q=${encodeURIComponent(args.query || "")}`));
  if (name === "list_agents") return result(await client.get("/api/agents"));
  if (name === "list_skills") return result(await client.get("/api/skills"));
  if (name === "search_knowledge") return result(await client.get(`/api/knowledge?q=${encodeURIComponent(args.query || "")}`));
  throw new Error(`Unknown tool ${name}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    try {
      let response;
      if (request.method === "initialize") {
        response = {
          protocolVersion: request.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "runyard-mcp", version: mcpVersion }
        };
      } else if (request.method === "tools/list") {
        response = { tools };
      } else if (request.method === "tools/call") {
        response = await callTool(request.params?.name, request.params?.arguments || {});
      } else if (request.method === "notifications/initialized") {
        continue;
      } else {
        throw new Error(`Unsupported method ${request.method}`);
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })}\n`);
    }
  }
});
