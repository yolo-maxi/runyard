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
  { name: "list_capabilities", description: "List available RunYard capabilities.", inputSchema: { type: "object", properties: {} } },
  { name: "search_capabilities", description: "Search capabilities by query.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
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
  { name: "search_knowledge", description: "Search Hub knowledge resources.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }
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
        label: "MCP: runyard",
        tool: "run_capability"
      }
    }));
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
