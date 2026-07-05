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

const TELEGRAM_TIME_FORMAT_RE = /^(r|w?[dD]?[tT]?)$/;

export function telegramTime(value, { format = "r", fallback = "" } = {}) {
  const unix = Number.isFinite(value) ? value : Math.floor(Date.parse(value || "") / 1000);
  if (!Number.isFinite(unix)) return htmlEscape(fallback || value || "");
  const safeFormat = TELEGRAM_TIME_FORMAT_RE.test(format) ? format : "r";
  return `<tg-time unix="${unix}" format="${safeFormat}">${htmlEscape(fallback || value)}</tg-time>`;
}

function fallbackDecisionAction(decision) {
  const label = approvalDecisionLabel(decision);
  if (label === "Approved") return { glyph: "✅", text: "Auto-approves" };
  if (label === "Changes requested") return { glyph: "⚠️", text: "Requests changes" };
  return { glyph: "🚫", text: "Auto-rejects" };
}

// Per-kind lead line: the first thing an approver reads must say what class
// of question this is, not a generic "approval requested".
const TELEGRAM_KIND_LEADS = {
  workflow_gate: "Gate needs sign-off",
  escalation: "Recovery decision needed",
  side_effect: "Side effect needs sign-off",
  custom: "Approval requested"
};

export function telegramApprovalKindLead(kind) {
  return TELEGRAM_KIND_LEADS[kind] || TELEGRAM_KIND_LEADS.custom;
}

// What silence does, stated on every card: a timed card names its deadline and
// fallback; a blocking card says it waits. Never leave "ignoring this" with an
// unstated meaning.
export function telegramApprovalIfIgnoredLine(approval, context) {
  if (approval?.timerState === "fallback_required") return "Expired: needs human; no auto decision.";
  if (approval?.timeoutAt) {
    const fallback = context?.approval?.fallbackDecisionLabel || approval?.fallback?.decision;
    if (fallback) {
      const action = fallbackDecisionAction(fallback);
      return `${action.glyph} ${action.text} ${telegramTime(approval.timeoutAt, { format: "r", fallback: "soon" })}`;
    }
    return `⏱ Needs human ${telegramTime(approval.timeoutAt, { format: "r", fallback: "soon" })}; no auto decision.`;
  }
  return "Waits for a human; waiting never fails the run.";
}

// One resolved-state line for message edits: "✅ Approved by @fran at 17:42".
export function telegramApprovalResolvedLine(approval, context) {
  const resolution = context?.approval?.resolutionLabel || approvalDecisionLabel(approval?.resolution || approval?.decision);
  const glyph = (approval?.resolution || approval?.decision) === "approved" ? "✅" : "🚫";
  const via = context?.approval?.resolvedViaLabel || "";
  const by = approval?.resolvedBy ? ` by ${approval.resolvedBy}` : "";
  const at = approval?.resolvedAt ? ` ${telegramTime(approval.resolvedAt, { format: "r", fallback: "now" })}` : "";
  const viaSuffix = via && via !== "decided by a human" ? ` (${via})` : "";
  return htmlEscape(`${glyph} ${resolution}${by}`) + at + htmlEscape(viaSuffix);
}

export function telegramApprovalText(approval, { approvalContext, instanceName = "Runyard" } = {}) {
  const context = approvalContext(approval);
  const kind = context.approval?.kind || approval?.kind || "custom";
  const pending = (approval?.status || "pending") === "pending";
  const workflow = context.workflow?.name
    ? `${context.workflow.name}${context.workflow.slug ? ` (${context.workflow.slug})` : ""}`
    : "Unknown workflow";
  const ask = context.ask || {};
  const action = truncate(ask.action || context.proposedAction || "Resolve this approval.", 320);
  const reason = truncate(ask.reason || approval?.description || "", 500);
  const details = truncate(context.proposedChange || "", 900);
  const branchLine = context.targetBranch ? telegramLabeledLine("Target branch", context.targetBranch) : telegramLabeledLine("Branch", context.branch);
  const runLine = approval.runId
    ? `${telegramCode(approval.runId)}${context.run?.statusLabel ? ` (${htmlEscape(context.run.statusLabel)})` : ""}`
    : "No run attached";
  const options = Array.isArray(ask.options) ? ask.options : [];
  return [
    `<b>${htmlEscape(instanceName)} · ${htmlEscape(telegramApprovalKindLead(kind))}</b>`,
    `<b>${htmlEscape(truncate(approval?.title || "Approval", 240))}</b>`,
    "<b>Approve</b>",
    htmlEscape(action),
    reason && reason !== action ? "<b>Why</b>" : "",
    reason && reason !== action ? htmlEscape(reason) : "",
    details && details !== reason ? "<b>Details</b>" : "",
    details && details !== reason ? `<pre>${htmlEscape(details)}</pre>` : "",
    ...(options.length
      ? ["<b>Options</b>", ...options.map((option) => htmlEscape(`• ${option.label}${option.effect ? ` — ${option.effect}` : ""}`))]
      : []),
    "<b>Context</b>",
    htmlEscape(workflow),
    telegramLabeledLine("From", context.requestedBy || "unknown"),
    telegramLabeledLine("For", context.ask?.audienceLabel || context.ask?.audience || ""),
    context.project?.display ? telegramLabeledLine("Project", truncate(context.project.display, 180)) : "",
    branchLine,
    context.deploy == null ? "" : telegramLabeledLine("Deploy", context.deploy ? "yes" : "no"),
    `<b>Run:</b> ${runLine}`,
    telegramLabeledLine("Card", approval.id),
    pending ? "<b>Ignored</b>" : "",
    pending ? telegramApprovalIfIgnoredLine(approval, context) : "",
    pending ? "<b>Decide:</b> Approve · Changes · Reject" : telegramApprovalResolvedLine(approval, context)
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

// Rebuild the approval message for a decided card: the body ends with
// "✅ Approved by … at …" instead of "Use the buttons below to decide.", and
// the decision buttons are gone. Returns null when the callback carries no
// editable message reference.
export function telegramApprovalMessageEditPayload({ callback, approval, approvalContext, instanceName } = {}) {
  const target = telegramApprovalButtonClearPayload(callback || {});
  if (!target || !approval) return null;
  return {
    ...target,
    text: telegramApprovalText(approval, { approvalContext, instanceName }),
    parse_mode: "HTML"
  };
}

export function telegramApprovalStoredMessageCallback(message = {}) {
  if (message.inlineMessageId) return { inline_message_id: message.inlineMessageId };
  if (message.chatId && message.messageId) {
    return { message: { chat: { id: message.chatId }, message_id: message.messageId } };
  }
  return null;
}

export function telegramApprovalStoredMessage({ target, sendResult } = {}) {
  const messageId = sendResult?.message_id;
  const chatId = sendResult?.chat?.id ?? target?.chatId;
  if (!chatId || !messageId) return null;
  return { chatId, messageId };
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
  if (decision === "superseded") return "Superseded";
  if (decision === "rejected" || !decision) return "Rejected";
  // Never default an unknown value to "Rejected" — humanize it instead.
  return String(decision).replace(/_/g, " ");
}
