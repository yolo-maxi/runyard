import { absoluteDeepLink, deepLinks } from "./deepLinks.js";
import {
  shouldNotifyTelegram as shouldNotifyTelegramApproval,
  telegramApprovalTarget as resolveTelegramApprovalTarget
} from "./telegramApprovals.js";
import {
  answerTelegramCallbackQuery as sendTelegramCallbackAnswer,
  clearTelegramApprovalButtons as clearTelegramApprovalMarkup,
  sendTelegramApprovalNotification
} from "./telegramBotClient.js";

export function createTelegramApprovalNotifier({
  approvalContext,
  env,
  getCapability,
  getRun,
  sendApprovalNotification = sendTelegramApprovalNotification,
  sendCallbackAnswer = sendTelegramCallbackAnswer,
  clearApprovalMarkup = clearTelegramApprovalMarkup
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
    return sendApprovalNotification({
      botToken: env.telegramBotToken,
      target,
      approval,
      approvalUrl,
      approvalContext,
      instanceName: env.instanceName
    });
  }

  async function answerTelegramCallbackQuery(callbackQueryId, text) {
    return sendCallbackAnswer({ botToken: env.telegramBotToken, callbackQueryId, text });
  }

  async function clearTelegramApprovalButtons(callback) {
    return clearApprovalMarkup({ botToken: env.telegramBotToken, callback });
  }

  return {
    answerTelegramCallbackQuery,
    clearTelegramApprovalButtons,
    notifyTelegram,
    shouldNotifyTelegram,
    telegramApprovalTarget
  };
}
