#!/usr/bin/env node
import { HubClient } from "./apiClient.js";

const client = new HubClient({
  baseUrl: process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117",
  token: process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN
});

const tools = [
  { name: "list_capabilities", description: "List available Smithers Hub capabilities.", inputSchema: { type: "object", properties: {} } },
  { name: "search_capabilities", description: "Search capabilities by query.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_capability", description: "Describe a capability, schemas, permissions, skills, agents, and workflow.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "run_capability", description: "Run a capability with JSON input.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, input: { type: "object" } } } },
  { name: "get_run_status", description: "Get run status and summary.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_logs", description: "Get run event log text.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "get_run_artifacts", description: "List artifacts for a run.", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } } },
  { name: "list_pending_approvals", description: "List pending approvals.", inputSchema: { type: "object", properties: {} } },
  { name: "approve_run", description: "Approve a Hub approval request.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
  { name: "reject_run", description: "Reject a Hub approval request.", inputSchema: { type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" }, comment: { type: "string" } } } },
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
  if (name === "list_capabilities") return result(await client.get("/api/capabilities"));
  if (name === "search_capabilities") return result(await client.get(`/api/capabilities?q=${encodeURIComponent(args.query || "")}`));
  if (name === "describe_capability") return result(await client.get(`/api/capabilities/${encodeURIComponent(args.id)}`));
  if (name === "run_capability") return result(await client.post(`/api/capabilities/${encodeURIComponent(args.id)}/run`, { input: args.input || {} }));
  if (name === "get_run_status") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}`));
  if (name === "get_run_logs") {
    const response = await fetch(`${client.baseUrl}/api/runs/${encodeURIComponent(args.runId)}/logs`, { headers: { authorization: `Bearer ${client.token}` } });
    return result(await response.text());
  }
  if (name === "get_run_artifacts") return result(await client.get(`/api/runs/${encodeURIComponent(args.runId)}/artifacts`));
  if (name === "list_pending_approvals") return result(await client.get("/api/approvals?status=pending"));
  if (name === "approve_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/approve`, { comment: args.comment || "Approved through MCP" }));
  if (name === "reject_run") return result(await client.post(`/api/approvals/${encodeURIComponent(args.approvalId)}/reject`, { comment: args.comment || "Rejected through MCP" }));
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
