#!/usr/bin/env node
import { HubClient } from "./apiClient.js";
import { resolveRemote } from "./config.js";
import { resolveHubUrl, resolveHubToken } from "./hubConnection.js";
import { MCP_TOOLS as tools } from "./mcpTools.js";
import { packageVersion as mcpVersion } from "./packageInfo.js";

// Resolve target hub from (in order): env, --remote <name> in argv, the current saved remote.
const remoteArgIndex = process.argv.indexOf("--remote");
const remoteName = remoteArgIndex >= 0 ? process.argv[remoteArgIndex + 1] : null;
const remote = resolveRemote(remoteName);
const client = new HubClient({
  baseUrl: resolveHubUrl({ remote }),
  token: resolveHubToken({ remote })
});

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
  if (name === "get_run_timeline") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/timeline${queryString({ since: args.since || args.cursor, limit: args.limit })}`));
  if (name === "get_run_diagnostics") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/diagnostics`));
  if (name === "get_run_logs") {
    const response = await fetch(`${client.baseUrl}/api/runs/${encodeURIComponent(args.runId)}/logs`, { headers: { authorization: `Bearer ${client.token}` } });
    return result(await response.text());
  }
  if (name === "get_run_artifacts") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/artifacts`));
  if (name === "download_artifact") {
    const response = await fetch(`${client.baseUrl}/api/artifacts/${encodeURIComponent(args.artifactId || args.id)}/download`, {
      headers: { authorization: `Bearer ${client.token}` }
    });
    if (!response.ok) return result(await response.text());
    const mimeType = response.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    const isText = /^text\/|[/+](json|xml|yaml|javascript)\b|^application\/(json|xml|yaml|javascript)/.test(mimeType);
    if (isText) return result(bytes.toString("utf8"));
    return result({ mimeType, encoding: "base64", sizeBytes: bytes.length, data: bytes.toString("base64") });
  }
  if (name === "rerun_workflow_run" || name === "rerun_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/rerun`, {
    input: args.input || undefined,
    executionMode: args.executionMode || args.where || undefined,
    runnerLocation: args.runnerLocation || undefined
  }));
  if (name === "promote_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/promote`, { note: args.note || "" }));
  if (name === "list_runners") return result(await client.get("/api/runners"));
  if (name === "whoami") return result(await client.get("/api/me"));
  if (name === "list_schedules") return result(await client.get("/api/schedules"));
  if (name === "get_schedule") return result(await client.get(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}`));
  if (name === "preview_schedule") return result(await client.get(`/api/schedules/preview${queryString({ cron: args.cron, timezone: args.timezone })}`));
  if (name === "create_schedule" || name === "update_schedule") {
    const body = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.workflow !== undefined || args.capability !== undefined) body.workflowSlug = args.workflow || args.capability;
    if (args.cron !== undefined) body.cron = args.cron;
    if (args.runAt !== undefined) body.runAt = args.runAt;
    if (args.timezone !== undefined) body.timezone = args.timezone;
    if (args.input !== undefined) body.input = args.input;
    if (args.description !== undefined) body.description = args.description;
    if (args.enabled !== undefined) body.enabled = args.enabled;
    if (name === "create_schedule") return result(await client.post("/api/schedules", body));
    return result(await client.patch(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}`, body));
  }
  if (name === "enable_schedule") return result(await client.post(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}/enable`, {}));
  if (name === "disable_schedule") return result(await client.post(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}/disable`, {}));
  if (name === "delete_schedule") return result(await client.delete(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}`));
  if (name === "run_schedule_now") return result(await client.post(`/api/schedules/${encodeURIComponent(args.scheduleId || args.id)}/run-now`, {}));
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
  if (name === "create_token") return result(await client.post("/api/tokens", {
    name: args.name,
    scopes: args.scopes || ["api", "mcp"],
    ...(args.expiresInDays ? { expiresInDays: args.expiresInDays } : {})
  }));
  if (name === "revoke_token") return result(await client.delete(`/api/tokens/${encodeURIComponent(args.tokenId || args.id)}`));
  if (name === "list_secrets") return result(await client.get("/api/secrets"));
  if (name === "set_secret") return result(await client.put(`/api/secrets/${encodeURIComponent(args.key)}`, {
    value: args.value,
    ...(args.description !== undefined ? { description: args.description } : {})
  }));
  if (name === "delete_secret") return result(await client.delete(`/api/secrets/${encodeURIComponent(args.key)}`));
  if (name === "list_pending_approvals") return result(await client.get("/api/approvals?status=pending"));
  if (name === "list_approvals") return result(await client.get(`/api/approvals${queryString({ status: args.status })}`));
  if (name === "get_approval") return result(await client.get(`/api/approvals/${encodeURIComponent(args.approvalId || args.id)}`));
  if (name === "create_approval") return result(await client.post("/api/approvals", {
    title: args.title,
    description: args.description || "",
    runId: args.runId || undefined,
    ask: args.ask || undefined,
    payload: args.payload || undefined,
    timeoutMs: args.timeoutMs ?? undefined,
    timeoutAt: args.timeoutAt || undefined,
    fallback: args.fallback || undefined
  }));
  if (name === "list_hooks") {
    const slug = args.workflow || args.capability;
    return result(await client.get(`/api/hooks${slug ? `?workflow=${encodeURIComponent(slug)}` : ""}`));
  }
  if (name === "get_hook") return result(await client.get(`/api/hooks/${encodeURIComponent(args.hookSlug || args.slug)}`));
  if (name === "upsert_hook") return result(await client.post("/api/hooks", args.hook || args));
  if (name === "validate_hook") return result(await client.post(`/api/hooks/${encodeURIComponent(args.hookSlug || args.slug)}/validate`, {}));
  if (name === "get_audit_log") return result(await client.get(`/api/audit${queryString({ limit: args.limit })}`));
  if (name === "list_alerts") return result(await client.get(`/api/alerts${queryString({ kind: args.kind, limit: args.limit })}`));
  if (name === "approve_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/approve`, { comment: args.comment || "Approved through MCP" }));
  if (name === "reject_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/reject`, { comment: args.comment || "Rejected through MCP" }));
  if (name === "request_changes_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/request-changes`, { comment: args.comment || "Changes requested through MCP" }));
  if (name === "cancel_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/cancel`, { reason: args.reason || "Cancelled through MCP" }));
  if (name === "search_artifacts") return result(await client.get(`/api/artifacts?q=${encodeURIComponent(args.query || "")}`));
  if (name === "list_agents") return result(await client.get("/api/agents"));
  if (name === "list_skills") return result(await client.get("/api/skills"));
  if (name === "search_knowledge") return result(await client.get(`/api/knowledge?q=${encodeURIComponent(args.query || "")}`));
  if (name === "create_agent") return result(await client.post("/api/agents", args.agent || args));
  if (name === "update_agent") return result(await client.patch(`/api/agents/${encodeURIComponent(args.slug)}`, args.agent || args));
  if (name === "create_skill") return result(await client.post("/api/skills", args.skill || args));
  if (name === "update_skill") return result(await client.patch(`/api/skills/${encodeURIComponent(args.slug)}`, args.skill || args));
  if (name === "create_knowledge") return result(await client.post("/api/knowledge", args.knowledge || args));
  if (name === "update_knowledge") return result(await client.patch(`/api/knowledge/${encodeURIComponent(args.slug)}`, args.knowledge || args));
  if (name === "get_dashboard") return result(await client.get("/api/dashboard"));
  if (name === "list_workflow_bundles") {
    const slug = args.workflow || args.capability;
    return result(await client.get(`/api/workflow-bundles${slug ? `?capability=${encodeURIComponent(slug)}` : ""}`));
  }
  if (name === "get_workflow_bundle") return result(await client.get(`/api/workflow-bundles/${encodeURIComponent(args.bundleId || args.id)}`));
  if (name === "publish_workflow_bundle") return result(await client.post("/api/workflow-bundles", {
    capabilitySlug: args.workflow || args.capability || args.capabilitySlug,
    code: args.code,
    ...(args.language ? { language: args.language } : {})
  }));
  if (name === "get_update_status") return result(await client.get("/api/update-status"));
  if (name === "apply_update") return result(await client.post("/api/update/apply", {}));
  if (name === "get_assistant_status") return result(await client.get("/api/chat/status"));
  if (name === "ask_assistant") return result(await client.post("/api/chat", {
    messages: args.messages || [],
    ...(args.context ? { context: args.context } : {})
  }));
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
