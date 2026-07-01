import { actorName } from "./routeActors.js";

export function createSupportChatHandlers({
  buildSupportLiveContext,
  chatWithSupportAgent,
  recordAudit,
  supportAgentInfo
} = {}) {
  return {
    status(_req, res) {
      res.json(supportAgentInfo());
    },

    async chat(req, res) {
      const body = req.body || {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return res.status(400).json({ error: "messages array required" });
      try {
        const baseContext = body.context && typeof body.context === "object" ? body.context : {};
        const live = buildSupportLiveContext(baseContext);
        const result = await chatWithSupportAgent({
          messages,
          context: { ...baseContext, live: live.text || "" }
        });
        recordAudit(
          actorName(req.token, "unknown"),
          "chat.message",
          `support-agent:${result.provider}/${result.model}`,
          { view: baseContext.view || "", turns: messages.length, contextKind: live.kind || "" }
        );
        res.json({
          reply: result.reply,
          provider: result.provider,
          model: result.model
        });
      } catch (error) {
        res.status(503).json({ error: error.message || "support agent unavailable" });
      }
    }
  };
}
