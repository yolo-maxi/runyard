#!/usr/bin/env node
import { HubClient } from "./apiClient.js";
import { resolveRemote } from "./config.js";

// Resolve target hub from (in order): env, --remote <name> in argv, the current saved remote.
const remoteArgIndex = process.argv.indexOf("--remote");
const remoteName = remoteArgIndex >= 0 ? process.argv[remoteArgIndex + 1] : null;
const remote = resolveRemote(remoteName);
const client = new HubClient({
  baseUrl: process.env.SMITHERS_HUB_URL || process.env.HUB_URL || remote.url || "http://127.0.0.1:43117",
  token: process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || remote.token
});

// Public contract: an agent landing on this MCP should reach for *capabilities*,
// not the smithers-orchestrator workflow surface. The capability is the Hub's
// versioned, schema-bearing, approval-aware unit of work. The compatibility
// aliases at the bottom (`list_workflows`, `run_workflow`, `list_runs`,
// `watch_run`) exist so an agent trained on the smithers-orchestrator MCP
// (or a session that still has its tool names cached) lands on the Hub
// catalog instead of a silent empty result.
const tools = [
  { name: "get_menu", description: "Show the Runyard menu: discovery steps, local vs remote execution choices, the public capability contract, and Hub output/artifact follow-up paths.", inputSchema: { type: "object", properties: {} } },
  { name: "list_capabilities", description: "List available Smithers Hub capabilities. This is the public contract — start here for any 'do X' request before reaching for a workflow.", inputSchema: { type: "object", properties: {} } },
  { name: "search_capabilities", description: "Search capabilities by query. Run this for any new task before deciding to write code by hand.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_capability", description: "Describe a capability, schemas, permissions, skills, agents, and workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  {
    name: "run_capability",
    description: "Run a capability with JSON input. Pass executionMode 'local' to target a local runner or 'remote' to target the shared remote/VPS runner pool. Outputs and artifacts are fetched from the Hub. For improve, input.repoDir selects an allowlisted runner-local git repo to edit.",
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
  { name: "list_runs", description: "List recent runs across capabilities. Filter by capability slug or status.", inputSchema: { type: "object", properties: { capability: { type: "string" }, status: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_run_status", description: "Get run status and summary.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_logs", description: "Get run event log text.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_artifacts", description: "List artifacts for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "list_runners", description: "List registered runners, heartbeat state, capacity, active slots, and pool summary.", inputSchema: { type: "object", properties: {} } },
  { name: "list_pending_approvals", description: "List pending approvals.", inputSchema: { type: "object", properties: {} } },
  { name: "approve_run", description: "Approve a Hub approval request.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "reject_run", description: "Reject a Hub approval request.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "request_changes_run", description: "Request changes for a Hub approval request.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "cancel_run", description: "Cancel a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, reason: { type: "string" } } } },
  { name: "search_artifacts", description: "Search artifacts.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "list_agents", description: "List reusable Hub agents.", inputSchema: { type: "object", properties: {} } },
  { name: "list_skills", description: "List reusable Hub skills.", inputSchema: { type: "object", properties: {} } },
  { name: "search_knowledge", description: "Search Hub knowledge resources.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  // --- smithers-orchestrator MCP compatibility aliases ---------------------
  // These mirror the tool names exposed by the local `smithers` MCP server
  // (bun add -g smithers-orchestrator) so an agent that still calls
  // `list_workflows` / `run_workflow` / `list_runs` / `watch_run` lands on
  // the Hub capability catalog instead of an empty local workspace.
  { name: "list_workflows", description: "Compatibility alias for list_capabilities — returns the Hub capability catalog under the smithers-orchestrator MCP shape so legacy agents discover Hub work.", inputSchema: { type: "object", properties: {} } },
  {
    name: "run_workflow",
    description: "Compatibility alias for run_capability — accepts the smithers-orchestrator `workflowId`/`prompt` shape and dispatches it through the Hub.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string" },
        prompt: { type: "string" },
        input: { type: "object" },
        executionMode: { type: "string", enum: ["local", "remote", "auto"] }
      }
    }
  },
  { name: "watch_run", description: "Compatibility alias for get_run_status — returns the latest Hub status for a run id.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" }, timeoutMs: { type: "number" } } } }
];

function result(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

async function callTool(name, args = {}) {
  if (name === "get_menu") return result(await client.get("/api/menu"));
  if (name === "list_capabilities") return result(await client.get("/api/capabilities"));
  if (name === "search_capabilities") return result(await client.get(`/api/capabilities?q=${encodeURIComponent(args.query || "")}`));
  if (name === "describe_capability") return result(await client.get(`/api/capabilities/${encodeURIComponent(args.id)}`));
  if (name === "run_capability") {
    return result(await client.post(`/api/capabilities/${encodeURIComponent(args.id)}/run`, {
      input: args.input || {},
      executionMode: args.executionMode || args.where || undefined,
      runnerLocation: args.runnerLocation || undefined,
      origin: {
        type: "mcp",
        label: "MCP: smithers-hub",
        tool: "run_capability"
      }
    }));
  }
  if (name === "list_runs") {
    const params = new URLSearchParams();
    if (args.capability) params.set("capability", String(args.capability));
    if (args.status) params.set("status", String(args.status));
    if (args.limit) params.set("limit", String(args.limit));
    const qs = params.toString();
    return result(await client.get(`/api/runs${qs ? `?${qs}` : ""}`));
  }
  if (name === "get_run_status") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}`));
  if (name === "get_run_logs") {
    const response = await fetch(`${client.baseUrl}/api/runs/${encodeURIComponent(args.runId)}/logs`, { headers: { authorization: `Bearer ${client.token}` } });
    return result(await response.text());
  }
  if (name === "get_run_artifacts") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/artifacts`));
  if (name === "list_runners") return result(await client.get("/api/runners"));
  if (name === "list_pending_approvals") return result(await client.get("/api/approvals?status=pending"));
  if (name === "approve_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/approve`, { comment: args.comment || "Approved through MCP" }));
  if (name === "reject_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/reject`, { comment: args.comment || "Rejected through MCP" }));
  if (name === "request_changes_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/request-changes`, { comment: args.comment || "Changes requested through MCP" }));
  if (name === "cancel_run") return result(await client.post(`/api/runs/${encodeURIComponent(args.runId)}/cancel`, { reason: args.reason || "Cancelled through MCP" }));
  if (name === "search_artifacts") return result(await client.get(`/api/artifacts?q=${encodeURIComponent(args.query || "")}`));
  if (name === "list_agents") return result(await client.get("/api/agents"));
  if (name === "list_skills") return result(await client.get("/api/skills"));
  if (name === "search_knowledge") return result(await client.get(`/api/knowledge?q=${encodeURIComponent(args.query || "")}`));
  // --- smithers-orchestrator MCP compatibility aliases ---------------------
  if (name === "list_workflows") return result(await client.get("/api/capabilities"));
  if (name === "run_workflow") {
    const input = { ...(args.input && typeof args.input === "object" ? args.input : {}) };
    if (typeof args.prompt === "string" && args.prompt.trim() && input.prompt === undefined) {
      input.prompt = args.prompt;
    }
    return result(await client.post(`/api/capabilities/${encodeURIComponent(args.workflowId)}/run`, {
      input,
      executionMode: args.executionMode || undefined,
      origin: {
        type: "mcp",
        label: "MCP: smithers-hub (run_workflow alias)",
        tool: "run_workflow"
      }
    }));
  }
  if (name === "watch_run") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}`));
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
          serverInfo: { name: "smithers-hub-mcp", version: "0.1.0" }
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
