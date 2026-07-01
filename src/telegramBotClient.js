import { truncate } from "./presentation.js";
import {
  telegramApprovalButtonClearPayload,
  telegramApprovalMessagePayload
} from "./telegramApprovals.js";

export async function callTelegramBot({ botToken, method, payload, fetchImpl = fetch, logError = console.error, errorLabel = "Telegram request" } = {}) {
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

export async function sendTelegramApprovalNotification(options = {}) {
  const { botToken, target } = options;
  if (!botToken || !target) return false;
  return callTelegramBot({
    botToken,
    method: "sendMessage",
    payload: approvalNotificationPayload(options),
    fetchImpl: options.fetchImpl,
    logError: options.logError,
    errorLabel: "Telegram notification"
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
