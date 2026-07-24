#!/usr/bin/env node
// Shadow client: an external consumer of a live RunYard Hub that talks ONLY
// to the public HTTP surface — /openapi.json discovery plus the /api and
// /api/v1 endpoints — and never imports server internals. It proves that a
// third-party client with a scoped token can rebuild the web app's
// informational dashboard (read mode) and that mutation rights genuinely
// require a mutation scope (write mode creates and discards a run draft).
//
//   node scripts/shadow-client.mjs --base-url http://host:port --token shub_... [--mode read|write]
//
// Prints a JSON report to stdout; exits 0 only when every step behaved.
// Used by tests/shadow-client.test.js as a regression e2e; also runnable
// against a live deployment with a freshly minted read-only token.

const args = parseArgs(process.argv.slice(2));
const BASE = (args["base-url"] || process.env.RUNYARD_BASE_URL || "").replace(/\/$/, "");
const TOKEN = args.token || process.env.RUNYARD_TOKEN || "";
const MODE = args.mode || "read";

if (!BASE || !TOKEN) {
  process.stderr.write("usage: shadow-client.mjs --base-url <url> --token <token> [--mode read|write]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) parsed[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return parsed;
}

async function call(pathname, { method = "GET", body, auth = true } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

const report = { baseUrl: BASE, mode: MODE, steps: [], ok: true };

function step(name, ok, detail) {
  report.steps.push({ name, ok, ...detail });
  if (!ok) report.ok = false;
  return ok;
}

async function readDashboard() {
  // 1. Discovery: the OpenAPI document is the contract we build against.
  const openapi = await call("/openapi.json", { auth: false });
  const tags = (openapi.data?.tags || []).map((tag) => tag.name).sort();
  const paths = openapi.data?.paths || {};
  const v1Paths = Object.keys(paths).filter((p) => p.startsWith("/v1/"));
  const aliasBacklinks = v1Paths.filter((p) =>
    Object.values(paths[p]).every((operation) => operation["x-canonical-path"])
  );
  step("openapi", openapi.status === 200 && tags.length === 10 && v1Paths.length >= 60 && aliasBacklinks.length === v1Paths.length, {
    status: openapi.status,
    groups: tags,
    v1PathCount: v1Paths.length
  });

  const version = await call("/api/version", { auth: false });
  step("version", version.status === 200 && Boolean(version.data?.version), { status: version.status, version: version.data?.version });

  const me = await call("/api/me");
  step("whoami", me.status === 200, { status: me.status, scopes: me.data?.token?.scopes });

  // 2. The informational dashboard, over /api/v1 grouped aliases.
  const menu = await call("/api/v1/system/menu");
  step("menu", menu.status === 200 && Array.isArray(menu.data?.tools), {
    status: menu.status, tools: menu.data?.tools?.length, workflows: menu.data?.workflows?.length
  });

  const workflows = await call("/api/v1/workflows");
  const workflowList = workflows.data?.workflows || workflows.data?.capabilities || [];
  step("workflows", workflows.status === 200 && Array.isArray(workflowList), { status: workflows.status, count: workflowList.length });
  report.firstWorkflow = workflowList[0]?.slug || null;

  const runs = await call("/api/v1/runs?limit=50");
  const runList = runs.data?.runs || [];
  const byStatus = {};
  for (const run of runList) byStatus[run.status] = (byStatus[run.status] || 0) + 1;
  step("runs", runs.status === 200 && Array.isArray(runList), { status: runs.status, count: runList.length, byStatus });

  const approvals = await call("/api/v1/approvals?status=pending");
  step("approvals", approvals.status === 200, { status: approvals.status, pending: approvals.data?.approvals?.length });

  const schedules = await call("/api/v1/automation/schedules");
  step("schedules", schedules.status === 200, { status: schedules.status, count: schedules.data?.schedules?.length });

  const runners = await call("/api/runners");
  step("runners", runners.status === 200, { status: runners.status, count: runners.data?.runners?.length });

  const dashboard = await call("/api/v1/system/dashboard");
  step("dashboard", dashboard.status === 200, { status: dashboard.status });

  // 3. Human/agent discovery surfaces exist.
  const llms = await call("/llms.txt", { auth: false });
  step("llms.txt", llms.status === 200 && String(llms.data).includes("read-only"), { status: llms.status });
  const docs = await call("/docs", { auth: false });
  step("docs", docs.status === 200 || docs.status === 301 || docs.status === 302, { status: docs.status });

  // 4. Mutation probes: a read-only token must be refused with 403
  //    insufficient scope on every one of these.
  const probes = [
    ["POST", "/api/v1/runs/drafts", { workflow: report.firstWorkflow || "hello", input: {} }],
    ["POST", "/api/v1/automation/schedules", { name: "shadow", workflowSlug: report.firstWorkflow || "hello", cron: "0 0 * * *" }],
    ["POST", "/api/v1/admin/tokens", { name: "escalation", scopes: ["admin"] }],
    ["POST", "/api/tokens", { name: "escalation", scopes: ["admin"] }]
  ];
  const denials = [];
  for (const [method, pathname, body] of probes) {
    const result = await call(pathname, { method, body });
    denials.push({ method, pathname, status: result.status, error: result.data?.error });
  }
  report.mutationDenials = denials;
  const scopes = me.data?.token?.scopes || [];
  if (scopes.length === 1 && scopes[0] === "read") {
    step("read-only-denied-mutations", denials.every((denial) => denial.status === 403 && denial.error === "insufficient scope"), {});
  }
}

async function writeProbe() {
  const workflows = await call("/api/v1/workflows");
  const slug = (workflows.data?.workflows || [])[0]?.slug;
  if (!step("workflows", workflows.status === 200 && Boolean(slug), { status: workflows.status, slug })) return;

  // Create a run draft — a real mutation that never enqueues or executes
  // anything — then discard it, leaving the deployment as we found it.
  const created = await call("/api/v1/runs/drafts", {
    method: "POST",
    body: { workflow: slug, input: { title: "shadow-client write probe" } }
  });
  const draftId = created.data?.draft?.id;
  step("draft-created", created.status === 201 && Boolean(draftId), {
    status: created.status, draftId, draftStatus: created.data?.draft?.status
  });
  if (!draftId) return;

  const fetched = await call(`/api/v1/runs/drafts/${encodeURIComponent(draftId)}`);
  step("draft-read", fetched.status === 200, { status: fetched.status });

  const discarded = await call(`/api/v1/runs/drafts/${encodeURIComponent(draftId)}/discard`, { method: "POST" });
  step("draft-discarded", discarded.status === 200, { status: discarded.status });
}

try {
  if (MODE === "write") await writeProbe();
  else await readDashboard();
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack || error);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
