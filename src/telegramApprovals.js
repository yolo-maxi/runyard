import { truncate } from "./presentation.js";

export function firstCsvValue(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)[0] || "";
}

export function telegramApprovalTarget({ approvalChatId = "", telegramChatId = "", telegramThreadId = "" } = {}) {
  const approvalTarget = firstCsvValue(approvalChatId);
  if (approvalTarget) return { chatId: approvalTarget, private: true };
  if (telegramChatId) {
    const threadId = Number(telegramThreadId);
    return {
      chatId: telegramChatId,
      private: false,
      ...(telegramThreadId && Number.isFinite(threadId) ? { threadId } : {})
    };
  }
  return null;
}

export function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

export function telegramCode(value) {
  return `<code>${htmlEscape(value)}</code>`;
}

export function telegramLabeledLine(label, value) {
  if (value == null || value === "") return "";
  return `<b>${htmlEscape(label)}:</b> ${htmlEscape(value)}`;
}

export function telegramApprovalText(approval, { approvalContext, instanceName = "Runyard" } = {}) {
  const context = approvalContext(approval);
  const workflow = context.workflow?.name
    ? `${context.workflow.name}${context.workflow.slug ? ` (${context.workflow.slug})` : ""}`
    : "Unknown workflow";
  const proposedChange = truncate(context.proposedChange || approval?.title || approval?.description || "Approval request", 900);
  const proposedAction = truncate(context.proposedAction || "Resolve this approval.", 320);
  const branchLine = context.targetBranch ? telegramLabeledLine("Target branch", context.targetBranch) : telegramLabeledLine("Branch", context.branch);
  const runLine = approval.runId
    ? `${telegramCode(approval.runId)}${context.run?.status ? ` (${htmlEscape(context.run.status)})` : ""}`
    : "No run attached";
  return [
    `<b>${htmlEscape(instanceName)} approval requested</b>`,
    "",
    "<b>Thing being approved</b>",
    "<b>Proposed change</b>",
    `<pre>${htmlEscape(proposedChange)}</pre>`,
    "",
    "<b>Decision / action</b>",
    htmlEscape(proposedAction),
    "",
    "<b>Workflow</b>",
    htmlEscape(workflow),
    "",
    telegramLabeledLine("Originator", context.requestedBy || "unknown"),
    context.project?.display ? telegramLabeledLine("Project / repo / path", truncate(context.project.display, 180)) : "",
    branchLine,
    context.deploy == null ? "" : telegramLabeledLine("Deploy", context.deploy ? "yes" : "no"),
    "",
    "<b>Run</b>",
    runLine,
    telegramLabeledLine("Approval", approval.id),
    "",
    "Use the buttons below to decide."
  ]
    .filter(Boolean)
    .join("\n");
}

export function telegramApprovalOpenButton(target, approvalUrl) {
  if (target.private) return { text: "Open approval", web_app: { url: approvalUrl } };
  return { text: "Open approval", url: approvalUrl };
}

export function telegramApprovalMessagePayload({ target, approval, approvalUrl, approvalContext, instanceName }) {
  return {
    chat_id: target.chatId,
    ...(target.threadId ? { message_thread_id: target.threadId } : {}),
    text: telegramApprovalText(approval, { approvalContext, instanceName }),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [telegramApprovalOpenButton(target, approvalUrl)],
        [
          { text: "Approve", callback_data: `approval:approve:${approval.id}` },
          { text: "Request changes", callback_data: `approval:request_changes:${approval.id}` },
          { text: "Reject", callback_data: `approval:reject:${approval.id}` }
        ]
      ]
    }
  };
}

export function isRunStartApproval(approval) {
  const payload = approval?.payload || {};
  const kind = String(payload.approvalKind || payload.kind || "").toLowerCase();
  const scope = String(payload.approvalScope || payload.scope || "").toLowerCase();
  if (kind || scope) return kind === "run_start" || scope === "workflow_start";

  return Boolean(approval?.runId && payload.capability && payload.input && /^Approve\b/.test(approval.title || ""));
}

export function runStartApprovalPolicy(approval, { getRun, getCapability } = {}) {
  const payload = approval?.payload || {};
  const run = approval?.runId ? getRun?.(approval.runId) : null;
  const capabilitySlug = payload.capability || run?.capabilitySlug || "";
  return capabilitySlug ? getCapability?.(capabilitySlug)?.approvalPolicy || {} : {};
}

export function shouldNotifyTelegram(approval, deps = {}) {
  if (!approval) return false;
  if (!isRunStartApproval(approval)) return true;
  const policy = runStartApprovalPolicy(approval, deps) || {};
  if (policy.notifyTelegram === false || policy.telegramNotify === false) return false;
  if (policy.notifications?.telegram === false || policy.notify?.telegram === false) return false;
  return true;
}

export function parseTelegramApprovalCallback(data) {
  if (typeof data !== "string" || !data.trim()) return { ok: false, code: 400, error: "missing callback data" };
  const parts = data.split(":");
  let action = "";
  let approvalId = "";
  if (parts.length === 2) {
    [action, approvalId] = parts;
  } else if (parts.length === 3 && parts[0] === "approval") {
    [, action, approvalId] = parts;
  } else {
    return { ok: false, code: 400, error: "invalid callback data format" };
  }
  const normalizedAction = action.replace(/-/g, "_");
  if (!["approve", "reject", "request_changes", "changes_requested", "changes"].includes(normalizedAction)) {
    return { ok: false, code: 400, error: "invalid approval decision" };
  }
  if (!/^appr_[a-f0-9]{20}$/.test(approvalId)) return { ok: false, code: 400, error: "invalid approval id" };
  return {
    ok: true,
    approvalId,
    decision: normalizedAction === "approve" ? "approved" : normalizedAction === "reject" ? "rejected" : "changes_requested"
  };
}

export function telegramApprovalButtonClearPayload(callback) {
  if (callback.inline_message_id) {
    return { inline_message_id: callback.inline_message_id, reply_markup: { inline_keyboard: [] } };
  }
  if (callback.message?.chat?.id && callback.message?.message_id) {
    return {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] }
    };
  }
  return null;
}

export function approvalDecisionLabel(decision) {
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  return "Rejected";
}
