import {
  approvalCreateInput,
  decisionTriggersTerminalDelivery,
  defaultApprovalComment,
  findExistingChildRunApproval,
  requestedApprovalRunId
} from "./approvalRoutes.js";
import {
  approvalDecisionLabel,
  parseTelegramApprovalCallback
} from "./telegramApprovals.js";
import { actorName } from "./routeActors.js";

function configuredSecret(value) {
  return typeof value === "function" ? value() : value;
}

export function telegramApprovalActor(callback = {}) {
  return `telegram:${callback.from?.username || callback.from?.id || "user"}`;
}

export function telegramApprovalComment(decision) {
  return decision === "changes_requested"
    ? "Changes requested from Telegram"
    : `${approvalDecisionLabel(decision)} from Telegram`;
}

export function approvalResolutionIssue(approval, { includeOk = false, withApprovalLinks = (item) => item } = {}) {
  const base = includeOk ? { ok: false } : {};
  if (!approval) {
    return {
      status: 404,
      body: { ...base, error: "approval not found" }
    };
  }
  if (approval.status !== "pending") {
    return {
      status: 409,
      body: {
        ...base,
        error: "approval is not pending",
        approval: withApprovalLinks(approval)
      }
    };
  }
  return null;
}

export function createApprovalHandlers({
  answerTelegramCallbackQuery,
  clearTelegramApprovalButtons,
  createApproval,
  dispatchRunResponseEndpointDelivery,
  getApproval,
  getRun,
  listApprovals,
  logger = console,
  notifyTelegram,
  resolveApproval,
  runOwnerTokenId,
  telegramApprovalTarget,
  telegramWebhookSecret,
  timingSafeEqualStr,
  withApprovalLinks
} = {}) {
  function resolveApprovalDecision({ approvalId, decision, actor, comment }) {
    const resolved = resolveApproval(approvalId, decision, actor, comment);
    if (resolved?.runId && decisionTriggersTerminalDelivery(decision)) {
      dispatchRunResponseEndpointDelivery(resolved.runId);
    }
    return resolved;
  }

  function resolveApprovalHttp(req, res, decision) {
    const approval = getApproval(req.params.id);
    const issue = approvalResolutionIssue(approval, { withApprovalLinks });
    if (issue) return res.status(issue.status).json(issue.body);
    const resolved = resolveApprovalDecision({
      approvalId: req.params.id,
      decision,
      actor: actorName(req.token),
      comment: req.body.comment || defaultApprovalComment(decision)
    });
    res.json({ approval: withApprovalLinks(resolved) });
  }

  return {
    listApprovals(req, res) {
      res.json({ approvals: listApprovals(req.query.status || "").map(withApprovalLinks) });
    },

    getApproval(req, res) {
      const approval = getApproval(req.params.id);
      const issue = approvalResolutionIssue(approval, { withApprovalLinks });
      if (issue?.status === 404) return res.status(issue.status).json(issue.body);
      res.json({ approval: withApprovalLinks(approval) });
    },

    async createApproval(req, res) {
      try {
        const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
        const ownershipIssue = runnerApprovalOwnershipIssue(req.token || {}, requestedApprovalRunId(req.body || {}, payload), {
          getRun,
          runOwnerTokenId
        });
        if (ownershipIssue) return res.status(ownershipIssue.status).json(ownershipIssue.body);
        const existing = findExistingChildRunApproval(listApprovals("pending"), payload);
        if (existing) return res.status(200).json({ approval: withApprovalLinks(existing), idempotent: true });

        // Only link to a run row that actually exists; child approvals may
        // reference not-yet-visible runs and should still surface as cards.
        const approval = createApproval(approvalCreateInput(req.body || {}, req.token || {}, { getRun }));
        await notifyTelegram(approval);
        res.status(201).json({ approval: withApprovalLinks(approval), idempotent: false });
      } catch (error) {
        logger.error?.("create approval failed:", error.message);
        res.status(400).json({ error: "could not create approval" });
      }
    },

    approve(req, res) {
      return resolveApprovalHttp(req, res, "approved");
    },

    reject(req, res) {
      return resolveApprovalHttp(req, res, "rejected");
    },

    requestChanges(req, res) {
      return resolveApprovalHttp(req, res, "changes_requested");
    },

    async telegramWebhook(req, res) {
      const webhookSecret = configuredSecret(telegramWebhookSecret);
      if (!webhookSecret) return res.status(503).json({ ok: false, error: "telegram webhook not configured" });
      const provided = req.headers["x-telegram-bot-api-secret-token"] || "";
      if (!timingSafeEqualStr(provided, webhookSecret)) return res.status(401).json({ ok: false });

      const callback = req.body.callback_query;
      if (!callback?.data) return res.json({ ok: true, ignored: "no callback query data" });

      const parsed = parseTelegramApprovalCallback(callback.data);
      if (!parsed.ok) {
        await answerTelegramCallbackQuery(callback.id, parsed.error);
        return res.status(parsed.code).json({ ok: false, error: parsed.error });
      }

      const target = telegramApprovalTarget();
      const chatId = String(callback.message?.chat?.id ?? "");
      if (target?.chatId && chatId && chatId !== String(target.chatId)) {
        await answerTelegramCallbackQuery(callback.id, "Approval button came from the wrong chat.");
        return res.status(403).json({ ok: false, error: "telegram callback chat mismatch" });
      }

      const approval = getApproval(parsed.approvalId);
      const issue = approvalResolutionIssue(approval, { includeOk: true, withApprovalLinks });
      if (issue?.status === 404) {
        await answerTelegramCallbackQuery(callback.id, "Approval was not found.");
        return res.status(issue.status).json(issue.body);
      }
      if (issue?.status === 409) {
        await answerTelegramCallbackQuery(callback.id, `Approval is already ${approval.status}.`);
        await clearTelegramApprovalButtons(callback);
        return res.status(issue.status).json(issue.body);
      }

      const resolved = resolveApprovalDecision({
        approvalId: parsed.approvalId,
        decision: parsed.decision,
        actor: telegramApprovalActor(callback),
        comment: telegramApprovalComment(parsed.decision)
      });
      await answerTelegramCallbackQuery(callback.id, `${approvalDecisionLabel(parsed.decision)}.`);
      await clearTelegramApprovalButtons(callback);
      return res.json({ ok: true, approval: withApprovalLinks(resolved) });
    }
  };
}

export function runnerApprovalOwnershipIssue(token = {}, requestedRunId, { getRun, runOwnerTokenId } = {}) {
  const scopes = token.scopes || [];
  if (scopes.includes("admin") || !scopes.includes("runner") || !requestedRunId) return null;
  if (!getRun?.(requestedRunId)) return null;
  if (runOwnerTokenId?.(requestedRunId) === token.id) return null;
  return {
    status: 403,
    body: { error: "run not owned by this runner" }
  };
}
