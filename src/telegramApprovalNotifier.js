import { absoluteDeepLink, deepLinks } from "./deepLinks.js";
import {
  telegramApprovalStoredMessage,
  telegramApprovalStoredMessageCallback,
  shouldNotifyTelegram as shouldNotifyTelegramApproval,
  telegramApprovalTarget as resolveTelegramApprovalTarget
} from "./telegramApprovals.js";
import {
  answerTelegramCallbackQuery as sendTelegramCallbackAnswer,
  clearTelegramApprovalButtons as clearTelegramApprovalMarkup,
  editTelegramApprovalMessage as editTelegramApprovalMessageText,
  sendTelegramApprovalNotification
} from "./telegramBotClient.js";

export function createTelegramApprovalNotifier({
  approvalContext,
  env,
  getCapability,
  getRun,
  setApprovalTelegramMessage = async () => {},
  sendApprovalNotification = sendTelegramApprovalNotification,
  sendCallbackAnswer = sendTelegramCallbackAnswer,
  clearApprovalMarkup = clearTelegramApprovalMarkup,
  editApprovalMessage = editTelegramApprovalMessageText
} = {}) {
  function telegramApprovalTarget() {
    return resolveTelegramApprovalTarget({
      approvalChatId: env.telegramApprovalChatId,
      telegramChatId: env.telegramChatId,
      telegramThreadId: env.telegramThreadId
    });
  }

  function shouldNotifyTelegram(approval) {
    return shouldNotifyTelegramApproval(approval, { getRun, getCapability });
  }

  async function notifyTelegram(approval) {
    const target = telegramApprovalTarget();
    if (!env.telegramBotToken || !target) return false;
    if (!shouldNotifyTelegram(approval)) return false;
    const approvalUrl = absoluteDeepLink(deepLinks.approval(approval.id), env.baseUrl);
    const result = await sendApprovalNotification({
      botToken: env.telegramBotToken,
      target,
      approval,
      approvalUrl,
      approvalContext,
      instanceName: env.instanceName
    });
    const message = telegramApprovalStoredMessage({ target, sendResult: result });
    if (message) await setApprovalTelegramMessage(approval.id, message);
    return Boolean(result);
  }

  async function answerTelegramCallbackQuery(callbackQueryId, text) {
    return sendCallbackAnswer({ botToken: env.telegramBotToken, callbackQueryId, text });
  }

  async function clearTelegramApprovalButtons(callback) {
    return clearApprovalMarkup({ botToken: env.telegramBotToken, callback });
  }

  // Post-decision follow-up: rewrite the original message to name the outcome
  // and actor. Falls back to clearing the buttons so a failed edit never
  // leaves live decision buttons on a decided card.
  async function updateTelegramApprovalMessage(callback, approval) {
    const edited = await editApprovalMessage({
      botToken: env.telegramBotToken,
      callback,
      approval,
      approvalContext,
      instanceName: env.instanceName
    });
    if (!edited) return clearTelegramApprovalButtons(callback);
    return true;
  }

  async function updateStoredTelegramApprovalMessage(approval) {
    const callback = telegramApprovalStoredMessageCallback(approval?.telegramMessage);
    if (!callback) return false;
    return updateTelegramApprovalMessage(callback, approval);
  }

  return {
    answerTelegramCallbackQuery,
    clearTelegramApprovalButtons,
    notifyTelegram,
    shouldNotifyTelegram,
    telegramApprovalTarget,
    updateStoredTelegramApprovalMessage,
    updateTelegramApprovalMessage
  };
}
