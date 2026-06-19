import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const { app, notifyTelegram } = await import("../src/server.js");
const { env } = await import("../src/env.js");
const { autoQueueLegacyRunStartApprovals, createApproval, updateRun } = await import("../src/db.js");

let server;
let baseUrl;
const token = "shub_test_token";
const telegramEnvKeys = [
  "telegramBotToken",
  "telegramApprovalChatId",
  "telegramApprovalUserIds",
  "telegramChatId",
  "telegramThreadId",
  "telegramWebhookSecret",
  "baseUrl"
];

function withTelegramEnv(overrides) {
  const previous = Object.fromEntries(telegramEnvKeys.map((key) => [key, env[key]]));
  Object.assign(env, overrides);
  return () => Object.assign(env, previous);
}

function captureTelegramFetch(calls) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://api.telegram.org/")) {
      calls.push({
        url: href.replace(/bot[^/]+/, "bot<redacted>"),
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return previousFetch(url, options);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

// Raw request that returns status without throwing, with an optional bearer token override.
function raw(pathname, options = {}, bearer = token) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

function signedTelegramInitData({ botToken, userId, authDate = Math.floor(Date.now() / 1000), hashOverride = "", user = {} }) {
  const params = new URLSearchParams({
    query_id: "AAE-test-query",
    user: JSON.stringify({ id: userId, first_name: "Fran", username: "fran", ...user }),
    auth_date: String(authDate)
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hashOverride || hash);
  return params.toString();
}

function firstCookie(setCookie) {
  return String(setCookie || "").split(";")[0];
}

async function createCheckpointApproval(capabilitySlug, input = {}) {
  const created = await api(`/api/capabilities/${capabilitySlug}/run`, {
    method: "POST",
    body: { input }
  });
  updateRun(created.run.id, { status: "waiting_approval", current_step: "waiting for checkpoint approval" });
  const approval = createApproval({
    runId: created.run.id,
    title: `Approve checkpoint for ${capabilitySlug}`,
    description: "Workflow checkpoint approval.",
    requestedBy: "token: bootstrap-admin",
    payload: {
      kind: "checkpoint",
      approvalKind: "checkpoint",
      approvalScope: "workflow_checkpoint",
      capability: capabilitySlug,
      input
    }
  });
  return { created, approval };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("Smithers Hub API", () => {
  it("authenticates with bootstrap token", async () => {
    const data = await api("/api/me");
    assert.equal(data.token.name, "bootstrap-admin");
  });

  it("lists seeded capabilities, agents, skills, and knowledge", async () => {
    const caps = await api("/api/capabilities");
    const agents = await api("/api/agents");
    const skills = await api("/api/skills");
    const knowledge = await api("/api/knowledge");
    assert.ok(caps.capabilities.find((cap) => cap.slug === "hello"));
    assert.ok(agents.agents.length >= 4);
    assert.ok(skills.skills.length >= 4);
    assert.ok(knowledge.knowledge.length >= 1);
  });

  it("creates a run, registers a runner, claims it, stores events and artifacts, and completes", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "Test Smithers Hub" } }
    });
    assert.equal(created.run.status, "queued");
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "test runner", hostname: "test", platform: "linux", tags: ["smithers", "node"] }
    });
    const assignment = await api(`/api/runners/${runner.runner.id}/next-run`);
    assert.equal(assignment.run.id, created.run.id);
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/events`, { method: "POST", body: { type: "workflow.step", message: "testing" } });
    await api(`/api/runs/${created.run.id}/artifacts`, {
      method: "POST",
      body: { name: "result.md", mimeType: "text/markdown", contentBase64: Buffer.from("# result").toString("base64") }
    });
    await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "succeeded");
    assert.equal(detail.artifacts.length, 1);
    assert.equal(readFileSync(detail.artifacts[0].path, "utf8"), "# result");
  });

  it("starts implement workflows without a run-start approval", async () => {
    const created = await api("/api/capabilities/implement/run", {
      method: "POST",
      body: { input: { repo: "/tmp", task: "test" } }
    });
    assert.equal(created.run.status, "queued");
    const approvals = await api("/api/approvals?status=pending");
    const approval = approvals.approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });
});

describe("Hardening: scopes, tokens, run state, webhook, health", () => {
  it("exposes an unauthenticated health endpoint", async () => {
    const res = await raw("/healthz", {}, null);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
  });

  it("enforces token scopes", async () => {
    // A read/run-only token (mcp) must not be able to mint tokens or edit the catalog.
    const created = await api("/api/tokens", { method: "POST", body: { name: "mcp-only", scopes: ["mcp"] } });
    const mcpToken = created.token.token;
    assert.ok(mcpToken);

    // Allowed: read capabilities and run them.
    const list = await raw("/api/capabilities", {}, mcpToken);
    assert.equal(list.status, 200);
    const run = await raw("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "scoped" } } }, mcpToken);
    assert.equal(run.status, 202);

    // Denied: minting tokens and editing the catalog require admin.
    const mint = await raw("/api/tokens", { method: "POST", body: { name: "evil", scopes: ["admin"] } }, mcpToken);
    assert.equal(mint.status, 403);
    const edit = await raw("/api/capabilities", { method: "POST", body: { name: "x" } }, mcpToken);
    assert.equal(edit.status, 403);
  });

  it("lists and revokes tokens, and revoked tokens stop working", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "throwaway", scopes: ["api", "mcp"] } });
    const id = created.token.id;
    const value = created.token.token;
    assert.equal((await raw("/api/me", {}, value)).status, 200);

    const list = await api("/api/tokens");
    assert.ok(list.tokens.find((entry) => entry.id === id && entry.active));

    await api(`/api/tokens/${id}`, { method: "DELETE" });
    assert.equal((await raw("/api/me", {}, value)).status, 401);
  });

  it("refuses to revoke the last active admin token", async () => {
    const me = await api("/api/me");
    const res = await raw(`/api/tokens/${me.token.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);
  });

  it("guards run state transitions", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "state" } } });
    const runId = created.run.id;
    await api(`/api/runs/${runId}/cancel`, { method: "POST", body: { reason: "stop" } });
    // Cannot complete a cancelled run.
    const complete = await raw(`/api/runs/${runId}/complete`, { method: "POST", body: { output: {} } });
    assert.equal(complete.status, 409);
    // Re-cancelling a cancelled run is idempotent.
    const reCancel = await raw(`/api/runs/${runId}/cancel`, { method: "POST", body: {} });
    assert.equal(reCancel.status, 200);
    assert.equal(reCancel.data.run.status, "cancelled");
  });

  it("does not double-assign a queued run to two runners", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "claim" } } });
    const a = await api("/api/runners/register", { method: "POST", body: { name: "a", hostname: "a", tags: ["smithers", "node"] } });
    const b = await api("/api/runners/register", { method: "POST", body: { name: "b", hostname: "b", tags: ["smithers", "node"] } });
    const claimA = await api(`/api/runners/${a.runner.id}/next-run`);
    const claimB = await api(`/api/runners/${b.runner.id}/next-run`);
    const claimed = [claimA, claimB].filter((c) => c.run && c.run.id === created.run.id);
    assert.equal(claimed.length, 1);
  });

  it("serves a one-line installer and a client bundle", async () => {
    const r1 = await fetch(`${baseUrl}/install.sh`);
    assert.equal(r1.status, 200);
    const body = await r1.text();
    assert.match(body, /Installing Smithers Hub client/);
    assert.match(body, /\/cli\.tgz/);
    assert.match(body, /smithers-hub mcp install/);
    const r2 = await fetch(`${baseUrl}/cli.tgz`);
    assert.equal(r2.status, 200);
    const buf = Buffer.from(await r2.arrayBuffer());
    assert.equal(buf[0], 0x1f); // gzip magic
    assert.equal(buf[1], 0x8b);

    const appPage = await fetch(`${baseUrl}/app`);
    assert.equal(appPage.status, 200);
    const csp = appPage.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/);
    assert.equal(appPage.headers.get("x-frame-options"), null);
    assert.match(await appPage.text(), /https:\/\/telegram\.org\/js\/telegram-web-app\.js\?62/);
    const appJs = await fetch(`${baseUrl}/public/app.js`);
    assert.equal(appJs.status, 200);
    const appCode = await appJs.text();
    assert.match(appCode, /\/api\/auth\/telegram-webapp/);
    assert.match(appCode, /window\.Telegram\?\.WebApp/);
    assert.match(appCode, /ready\?\.\(\)/);
  });

  it("rejects unconfigured / unauthenticated Telegram webhook calls", async () => {
    // No TELEGRAM_WEBHOOK_SECRET configured in the test env -> endpoint disabled.
    const res = await raw("/api/telegram/webhook", { method: "POST", body: { callback_query: { data: "approve:appr_x" } } }, null);
    assert.equal(res.status, 503);
  });

  it("authenticates Telegram WebApp initData for the approval operator", async () => {
    const botToken = "123456:test-bot-secret";
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "475212779",
      telegramApprovalUserIds: "475212779"
    });
    try {
      const { created, approval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Telegram WebApp auth valid",
        deploy: false
      });

      const initData = signedTelegramInitData({ botToken, userId: 475212779 });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 200);
      const cookie = firstCookie(auth.headers.get("set-cookie"));
      assert.match(cookie, /^shub_session=/);

      const me = await raw("/api/me", { headers: { cookie } }, null);
      assert.equal(me.status, 200);
      assert.equal(me.data.token.id, "telegram-webapp:475212779");
      assert.deepEqual(me.data.token.scopes, ["approvals"]);

      assert.equal((await raw(`/api/approvals/${approval.id}`, { headers: { cookie } }, null)).status, 200);
      assert.equal((await raw(`/api/runs/${created.run.id}`, { headers: { cookie } }, null)).status, 200);
      assert.equal((await raw("/api/capabilities", { headers: { cookie } }, null)).status, 403);

      const changed = await raw(
        `/api/approvals/${approval.id}/request-changes`,
        { method: "POST", headers: { cookie }, body: { comment: "Please revise from Telegram miniapp." } },
        null
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.data.approval.decision, "changes_requested");
      assert.equal(changed.data.approval.resolvedBy, "telegram:fran");
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("rejects Telegram WebApp initData with an invalid hash", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "475212779",
      telegramApprovalUserIds: "475212779"
    });
    try {
      const initData = signedTelegramInitData({ botToken, userId: 475212779, hashOverride: "0".repeat(64) });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 401);
      assert.equal(auth.data.error, "invalid telegram signature");
    } finally {
      restoreEnv();
    }
  });

  it("rejects Telegram WebApp initData for the wrong user", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "475212779",
      telegramApprovalUserIds: "475212779"
    });
    try {
      const initData = signedTelegramInitData({ botToken, userId: 111 });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 403);
      assert.equal(auth.data.error, "telegram user is not authorized");
    } finally {
      restoreEnv();
    }
  });

  it("rejects stale Telegram WebApp auth_date values", async () => {
    const botToken = "123456:test-bot-secret";
    const restoreEnv = withTelegramEnv({
      telegramBotToken: botToken,
      telegramApprovalChatId: "475212779",
      telegramApprovalUserIds: "475212779"
    });
    try {
      const authDate = Math.floor(Date.now() / 1000) - 3600;
      const initData = signedTelegramInitData({ botToken, userId: 475212779, authDate });
      const auth = await raw("/api/auth/telegram-webapp", { method: "POST", body: { initData } }, null);
      assert.equal(auth.status, 401);
      assert.equal(auth.data.error, "telegram auth expired");
    } finally {
      restoreEnv();
    }
  });

  it("does not create or notify workflow-start approvals by default", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "-100999",
      telegramThreadId: "77",
      baseUrl: "https://hub.example"
    });
    try {
      const created = await api("/api/capabilities/implement-change-gated/run", {
        method: "POST",
        body: { input: { workPrompt: "No noisy run-start DM", repo: "/home/xiko/smithers-hub", targetBranch: "main", deploy: true } }
      });
      assert.equal(created.run.status, "queued");
      const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
      assert.equal(approval, undefined);
      assert.equal(calls.filter((call) => call.url.endsWith("/sendMessage")).length, 0);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("auto-queues legacy pending workflow-start approvals", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { name: "legacy" } }
    });
    updateRun(created.run.id, { status: "waiting_approval", current_step: "waiting for approval" });
    createApproval({
      runId: created.run.id,
      title: "Approve legacy workflow start",
      description: "Legacy workflow-start gate.",
      requestedBy: "test",
      payload: { kind: "run_start", approvalKind: "run_start", approvalScope: "workflow_start" }
    });

    assert.equal(autoQueueLegacyRunStartApprovals(), 1);
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "queued");
    assert.equal(detail.run.currentStep, "queued");
    const approval = (await api("/api/approvals")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval.status, "approved");
    assert.equal(approval.resolvedBy, "system:auto-queue");
  });

  it("sends structured private Telegram checkpoint approvals with a miniapp open button", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "-100999",
      telegramThreadId: "77",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const created = await api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "Checkpoint Telegram notification" } }
      });
      const approval = createApproval({
        runId: created.run.id,
        title: "Approve production checkpoint",
        description: "A workflow checkpoint needs an operator decision.",
        requestedBy: "workflow: hello",
        payload: {
          kind: "approval_checkpoint",
          approvalKind: "checkpoint",
          approvalScope: "workflow_checkpoint",
          capability: "hello",
          input: {
            requestedBy: "Fran <ops>",
            proposedAction: "Approve the deploy checkpoint after tests pass.",
            change: "Ship <b>approval</b> DM formatting & keep JSON out",
            repo: "/home/xiko/smithers-hub",
            targetBranch: "main",
            deploy: true
          }
        }
      });
      await notifyTelegram(approval);

      const send = calls.find((call) => call.url.endsWith("/sendMessage"));
      assert.ok(send);
      assert.equal(send.body.chat_id, "12345");
      assert.equal(Object.hasOwn(send.body, "message_thread_id"), false);
      assert.equal(send.body.parse_mode, "HTML");
      assert.match(send.body.text, /<b>Thing being approved<\/b>/);
      assert.match(send.body.text, /<b>Proposed change<\/b>\n<pre>Ship &lt;b&gt;approval&lt;\/b&gt; DM formatting &amp; keep JSON out<\/pre>/);
      assert.match(send.body.text, /<b>Decision \/ action<\/b>\nApprove the deploy checkpoint after tests pass\./);
      assert.match(send.body.text, /<b>Workflow<\/b>\nHello \(Smithers proof\) \(hello\)/);
      assert.match(send.body.text, /<b>Originator:<\/b> Fran &lt;ops&gt;/);
      assert.match(send.body.text, /<b>Project \/ repo \/ path:<\/b> \/home\/xiko\/smithers-hub/);
      assert.match(send.body.text, /<b>Target branch:<\/b> main/);
      assert.match(send.body.text, /<b>Deploy:<\/b> yes/);
      assert.match(send.body.text, /<b>Run<\/b>\n<code>run_[a-f0-9]{20}<\/code> \(queued\)/);
      assert.match(send.body.text, /<b>Approval:<\/b> appr_[a-f0-9]{20}/);
      assert.doesNotMatch(send.body.text, /Approval link:/);
      assert.doesNotMatch(send.body.text, /"change"|"requestedBy"|\{|\}/);
      const buttons = send.body.reply_markup.inline_keyboard.flat();
      assert.ok(buttons.find((button) => button.text === "Open approval" && button.web_app?.url.includes("/app#approvals/")));
      assert.ok(buttons.find((button) => button.text === "Approve" && /^approval:approve:appr_[a-f0-9]{20}$/.test(button.callback_data)));
      assert.ok(buttons.find((button) => button.text === "Request changes" && /^approval:request_changes:appr_[a-f0-9]{20}$/.test(button.callback_data)));
      assert.ok(buttons.find((button) => button.text === "Reject" && /^approval:reject:appr_[a-f0-9]{20}$/.test(button.callback_data)));

      const approved = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-checkpoint-approve",
              data: `approval:approve:${approval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 21, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.data.approval.status, "approved");
      assert.equal(approved.data.approval.decision, "approved");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-checkpoint-approve");
      assert.ok(ack);
      assert.equal(ack.body.text, "Approved.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 21);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram approve callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: approveRun, approval: approveApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Approve from Telegram",
        deploy: false
      });
      const approved = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-approve",
              data: `approval:approve:${approveApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 11, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.data.approval.status, "approved");
      assert.equal(approved.data.approval.decision, "approved");
      assert.equal((await api(`/api/runs/${approveRun.run.id}`)).run.status, "queued");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-approve");
      assert.ok(ack);
      assert.equal(ack.body.text, "Approved.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 11);
      assert.ok(edit);
      assert.equal(String(edit.body.chat_id), "12345");
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram reject callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: rejectRun, approval: rejectApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Reject from Telegram",
        deploy: false
      });
      const rejected = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-reject",
              data: `reject:${rejectApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 12, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(rejected.status, 200);
      assert.equal(rejected.data.approval.status, "rejected");
      assert.equal(rejected.data.approval.decision, "rejected");
      assert.equal((await api(`/api/runs/${rejectRun.run.id}`)).run.status, "cancelled");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-reject");
      assert.ok(ack);
      assert.equal(ack.body.text, "Rejected.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 12);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("resolves Telegram request-changes callbacks and removes action buttons", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramChatId: "",
      telegramThreadId: "",
      telegramWebhookSecret: "telegram-test-secret",
      baseUrl: "https://hub.example"
    });
    try {
      const { created: changesRun, approval: changesApproval } = await createCheckpointApproval("implement-change-gated", {
        workPrompt: "Change this from Telegram",
        deploy: false
      });
      const changed = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: {
            callback_query: {
              id: "cb-changes",
              data: `approval:request_changes:${changesApproval.id}`,
              from: { id: 42, username: "fran" },
              message: { message_id: 13, chat: { id: 12345 } }
            }
          }
        },
        null
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.data.approval.status, "rejected");
      assert.equal(changed.data.approval.decision, "changes_requested");
      assert.equal(changed.data.approval.comment, "Changes requested from Telegram");
      const run = (await api(`/api/runs/${changesRun.run.id}`)).run;
      assert.equal(run.status, "cancelled");
      assert.equal(run.currentStep, "changes requested; run cancelled");
      const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-changes");
      assert.ok(ack);
      assert.equal(ack.body.text, "Changes requested.");
      const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup") && call.body.message_id === 13);
      assert.ok(edit);
      assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("rejects invalid Telegram callback data with a useful error", async () => {
    const calls = [];
    const restoreFetch = captureTelegramFetch(calls);
    const restoreEnv = withTelegramEnv({
      telegramBotToken: "test-bot-token",
      telegramApprovalChatId: "12345",
      telegramWebhookSecret: "telegram-test-secret"
    });
    try {
      const res = await raw(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "telegram-test-secret" },
          body: { callback_query: { id: "cb-invalid", data: "approval:maybe:appr_bad", message: { chat: { id: 12345 } } } }
        },
        null
      );
      assert.equal(res.status, 400);
      assert.equal(res.data.error, "invalid approval decision");
      assert.ok(calls.find((call) => call.url.endsWith("/answerCallbackQuery") && call.body.callback_query_id === "cb-invalid"));
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("keeps approval API and detail deep links available", async () => {
    const checkpoint = await createCheckpointApproval("idea-to-product", { idea: "Deep link approval test", deploy: false });
    const created = checkpoint.created;
    const approval = (await api(`/api/approvals/${checkpoint.approval.id}`)).approval;
    assert.equal(approval.deepLink, `/app#approvals/${approval.id}`);
    assert.equal(approval.deepLinkRun, `/app#runs/${created.run.id}`);
    assert.equal(approval.context.run.id, created.run.id);
    assert.equal(approval.context.deploy, false);
    assert.ok(approval.payloadSummary.input);

    const detail = await api(`/api/approvals/${approval.id}`);
    assert.equal(detail.approval.deepLink, `/app#approvals/${approval.id}`);
    assert.equal(detail.approval.context.workflow.slug, "idea-to-product");
    assert.equal(detail.approval.context.requestedBy, "token: bootstrap-admin");
    const appPage = await fetch(`${baseUrl}/app#approvals/${approval.id}`);
    assert.equal(appPage.status, 200);
  });

  it("resolves web/API request-changes decisions with a comment", async () => {
    const { created, approval } = await createCheckpointApproval("implement-change-gated", {
      workPrompt: "Needs more detail",
      deploy: false
    });
    const resolved = await api(`/api/approvals/${approval.id}/request-changes`, {
      method: "POST",
      body: { comment: "Please include the target branch and rollout plan." }
    });
    assert.equal(resolved.approval.status, "rejected");
    assert.equal(resolved.approval.decision, "changes_requested");
    assert.equal(resolved.approval.comment, "Please include the target branch and rollout plan.");
    const run = (await api(`/api/runs/${created.run.id}`)).run;
    assert.equal(run.status, "cancelled");
    assert.equal(run.currentStep, "changes requested; run cancelled");
  });

  it("has a readiness probe and run pagination metadata", async () => {
    assert.equal((await raw("/readyz", {}, null)).status, 200);
    const runs = await api("/api/runs?limit=5");
    assert.equal(typeof runs.total, "number");
    assert.equal(runs.limit, 5);
  });

  it("records an audit trail for token creation", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "audited", scopes: ["api"] } });
    const audit = await api("/api/audit");
    assert.ok(audit.audit.find((entry) => entry.action === "token.created" && entry.target === created.token.id));
  });

  it("blocks runners from touching runs they do not own", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "owner" } } });
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "runner-only", scopes: ["runner"] } })).token.token;
    // Has runner scope, but does not own this (unassigned) run -> 403.
    const start = await raw(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} }, runnerToken);
    assert.equal(start.status, 403);
  });

  it("does not let a runner token hijack another runner's id", async () => {
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "rt", scopes: ["runner"] } })).token.token;
    const mine = await raw("/api/runners/register", { method: "POST", body: { name: "mine", tags: ["smithers", "node"] } }, runnerToken);
    const myId = mine.data.runner.id;
    // A different token (admin) tries to register using my runner id -> must NOT overwrite mine.
    const other = await api("/api/runners/register", { method: "POST", body: { id: myId, name: "hijack", tags: ["smithers", "node"] } });
    assert.notEqual(other.runner.id, myId);
  });
});

describe("Smart Contract Audit capability", () => {
  it("is seeded as a real Smithers workflow capability", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "smart-contract-audit");
    assert.ok(cap, "smart-contract-audit capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/smart-contract-audit.tsx");
    assert.ok(cap.inputSchema.required.includes("target"));
    assert.equal(cap.enabled, true);
  });

  it("is runnable through the API (creates a queued run)", async () => {
    const created = await api("/api/capabilities/smart-contract-audit/run", {
      method: "POST",
      body: { input: { target: "/tmp/does-not-matter-for-queue", maxAgents: 2 } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "smart-contract-audit");
  });

  it("ships the workflow template in the runner bundle directory", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "smart-contract-audit.tsx");
    assert.ok(existsSync(tpl), "bundled workflow template should exist");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /prepare-sandbox\.sh/);
    assert.match(src, /build-bundles\.sh/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Gated implement-change capability", () => {
  it("is seeded as an approval-gated Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "implement-change-gated");
    assert.ok(cap, "implement-change-gated capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/implement-change-gated.tsx");
    assert.ok(cap.inputSchema.required.includes("workPrompt"));
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("queues immediately and relies on in-workflow approvals", async () => {
    const created = await api("/api/capabilities/implement-change-gated/run", {
      method: "POST",
      body: { input: { workPrompt: "noop", deploy: false } }
    });
    assert.equal(created.run.status, "queued");
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the gated workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "implement-change-gated.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /pnpm/);
    assert.match(src, /git.*push.*origin|push", "origin"/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});

describe("Idea to Product capability", () => {
  it("is seeded as an approval-gated Smithers workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "idea-to-product");
    assert.ok(cap, "idea-to-product capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/idea-to-product.tsx");
    assert.ok(cap.inputSchema.required.includes("idea"));
    assert.equal(cap.inputSchema.properties.publicAccess.type, "boolean");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers", "vps"]);
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("queues immediately and relies on in-workflow approvals", async () => {
    const created = await api("/api/capabilities/idea-to-product/run", {
      method: "POST",
      body: { input: { idea: "A tiny dashboard for tracking launch chores", deploy: false } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.capabilitySlug, "idea-to-product");
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });

  it("ships the idea-to-product workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "idea-to-product.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /repo\.box/);
    assert.match(src, /publicAccess/);
    assert.match(src, /Set-Cookie/);
    assert.match(src, /pnpm build/);
    assert.match(src, /ClaudeCodeAgent/);
  });
});
