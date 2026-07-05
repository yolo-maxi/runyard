import { truncate } from "./presentation.js";
import {
  telegramApprovalButtonClearPayload,
  telegramApprovalMessageEditPayload,
  telegramApprovalMessagePayload
} from "./telegramApprovals.js";
import {
  renderTelegramApprovalVisual,
  telegramApprovalVisualSummary
} from "./telegramApprovalVisual.js";

export async function callTelegramBot({ botToken, method, payload, fetchImpl = fetch, logError = console.error, errorLabel = "Telegram request", returnResult = false } = {}) {
  if (!botToken || !method || !payload) return false;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      logError(`${errorLabel} failed:`, response.status);
      return false;
    }
    if (returnResult && typeof response.json === "function") {
      const body = await response.json();
      return body?.result || body || true;
    }
    return true;
  } catch (error) {
    logError(`${errorLabel} failed:`, error.message);
    return false;
  }
}

export async function callTelegramBotFormData({ botToken, method, fields = {}, fetchImpl = fetch, logError = console.error, errorLabel = "Telegram request", returnResult = false } = {}) {
  if (!botToken || !method || !fields) return false;
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue;
      if (value instanceof Blob) {
        form.append(key, value, value.name || "approval.png");
      } else {
        form.append(key, String(value));
      }
    }
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      logError(`${errorLabel} failed:`, response.status);
      return false;
    }
    if (returnResult && typeof response.json === "function") {
      const body = await response.json();
      return body?.result || body || true;
    }
    return true;
  } catch (error) {
    logError(`${errorLabel} failed:`, error.message);
    return false;
  }
}

export function approvalNotificationPayload({ target, approval, approvalUrl, approvalContext, instanceName } = {}) {
  return telegramApprovalMessagePayload({
    target,
    approval,
    approvalUrl,
    approvalContext,
    instanceName
  });
}

export async function sendTelegramApprovalPhotoNotification(options = {}) {
  const { botToken, target, approval, approvalContext, renderApprovalVisual = renderTelegramApprovalVisual } = options;
  if (!botToken || !target || !approvalContext) return false;
  const summary = telegramApprovalVisualSummary(approvalContext(approval));
  if (!summary) return false;
  const message = approvalNotificationPayload(options);
  const png = await renderApprovalVisual(summary);
  if (!png?.length) return false;
  const photo = new Blob([png], { type: "image/png" });
  photo.name = "approval.png";
  return callTelegramBotFormData({
    botToken,
    method: "sendPhoto",
    fields: {
      chat_id: target.chatId,
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      photo,
      caption: message.text,
      parse_mode: message.parse_mode,
      reply_markup: JSON.stringify(message.reply_markup)
    },
    fetchImpl: options.fetchImpl,
    logError: options.logError,
    errorLabel: "Telegram approval photo notification",
    returnResult: true
  });
}

export const sendTelegramApprovalVisual = sendTelegramApprovalPhotoNotification;

export async function sendTelegramApprovalNotification(options = {}) {
  const { botToken, target } = options;
  if (!botToken || !target) return false;
  const photoResult = await sendTelegramApprovalPhotoNotification(options).catch((error) => {
    options.logError?.("Telegram approval photo notification failed:", error.message);
    return false;
  });
  if (photoResult) return photoResult;
  return callTelegramBot({
    botToken,
    method: "sendMessage",
    payload: approvalNotificationPayload(options),
    fetchImpl: options.fetchImpl,
    logError: options.logError,
    errorLabel: "Telegram notification",
    returnResult: true
  });
}

export async function answerTelegramCallbackQuery({ botToken, callbackQueryId, text, fetchImpl, logError } = {}) {
  if (!callbackQueryId || !botToken) return false;
  return callTelegramBot({
    botToken,
    method: "answerCallbackQuery",
    payload: { callback_query_id: callbackQueryId, text: truncate(text, 180), show_alert: false },
    fetchImpl,
    logError,
    errorLabel: "Telegram callback acknowledgement"
  });
}

// After a decision, rewrite the original approval message so it names the
// outcome and actor instead of still saying "Use the buttons below to
// decide.". Falls back to false (caller then clears just the buttons) when the
// callback has no editable message.
export async function editTelegramApprovalMessage({ botToken, callback, approval, approvalContext, instanceName, fetchImpl, logError } = {}) {
  if (!botToken) return false;
  const payload = telegramApprovalMessageEditPayload({ callback, approval, approvalContext, instanceName });
  if (!payload) return false;
  const caption = callback?.messageKind === "photo" || Array.isArray(callback?.message?.photo);
  if (caption) {
    payload.caption = payload.text;
    delete payload.text;
  }
  return callTelegramBot({
    botToken,
    method: caption ? "editMessageCaption" : "editMessageText",
    payload,
    fetchImpl,
    logError,
    errorLabel: "Telegram approval message update"
  });
}

export async function clearTelegramApprovalButtons({ botToken, callback, fetchImpl, logError } = {}) {
  if (!botToken) return false;
  const payload = telegramApprovalButtonClearPayload(callback);
  if (!payload) return false;
  return callTelegramBot({
    botToken,
    method: "editMessageReplyMarkup",
    payload,
    fetchImpl,
    logError,
    errorLabel: "Telegram approval button cleanup"
  });
}
