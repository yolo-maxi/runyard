import { promoteRunToMain, runPromotionCandidate } from "./runPromotion.js";

function mergeOutput(run, promotion) {
  return {
    ...(run.output && typeof run.output === "object" ? run.output : {}),
    promotion
  };
}

export function createRunPromotionHandlers({
  addRunEvent,
  getRun,
  scrubStoredSecrets,
  updateRun,
  withRunLinks
} = {}) {
  return {
    promoteRun(req, res) {
      const run = getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "run not found" });
      const candidate = runPromotionCandidate(run);
      if (!candidate.available) {
        return res.status(409).json({ error: `promotion unavailable: ${candidate.reason}`, candidate });
      }

      addRunEvent(run.id, "run.promotion.started", `Merging ${candidate.sourceBranch} into ${candidate.targetBranch}`, candidate);
      try {
        const promotion = promoteRunToMain(run, { gates: req.body?.gates !== false });
        const updated = updateRun(run.id, {
          current_step: `promoted to ${promotion.targetBranch}`,
          output: mergeOutput(run, promotion)
        });
        addRunEvent(run.id, "run.promotion.succeeded", `Merged ${promotion.sourceBranch} into ${promotion.targetBranch}`, promotion);
        return res.json({ run: withRunLinks ? withRunLinks(updated) : updated, promotion });
      } catch (error) {
        const message = scrubStoredSecrets
          ? scrubStoredSecrets(error.message || "promotion failed")
          : error.message || "promotion failed";
        addRunEvent(run.id, "run.promotion.failed", message, candidate);
        return res.status(409).json({ error: message, candidate });
      }
    }
  };
}
