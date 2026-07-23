import { createHash } from "node:crypto";
import { verifyGithubWebhookSignature } from "./githubApp.js";
import { extractPullRequestTrigger, extractPushTrigger } from "./ciTriggers.js";

// GitHub webhook ingress. Order is deliberate: raw-body signature check
// FIRST (nothing untrusted is parsed before it), then delivery-id dedupe
// with payload-hash conflict detection, then a small set of explicitly
// supported events. Every delivery leaves a bounded ledger row; ignored
// events are acknowledged 200 so GitHub never retries them.

export const SUPPORTED_PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];

export function payloadHash(rawBody) {
  return createHash("sha256").update(rawBody).digest("hex");
}

// In-memory since-boot operator counters (durable evidence lives in the
// delivery ledger + audit log; these make /api/ci/diagnostics cheap).
export function createWebhookCounters() {
  return {
    signatureFailures: 0,
    duplicates: 0,
    conflicts: 0,
    accepted: 0,
    ignored: 0,
    invalid: 0,
    errors: 0
  };
}

export function createGithubWebhookHandlers({
  env,
  githubApp,
  ciTriggers,
  advancePipeline,
  syncChecksSoon = () => {},
  findScmWebhookDelivery,
  recordScmWebhookDelivery,
  upsertScmInstallation,
  upsertScmRepo,
  getScmRepo,
  setScmRepoEnabled,
  recordAudit,
  counters = createWebhookCounters(),
  nowIso = () => new Date().toISOString(),
  logError = console.error
} = {}) {
  function syncInstallationFromPayload(payload, status) {
    const installation = payload.installation || {};
    if (!installation.id) return null;
    return upsertScmInstallation({
      installationId: installation.id,
      accountLogin: installation.account?.login || "",
      accountType: installation.account?.type || "",
      appId: installation.app_id || env.githubAppId || "",
      status
    });
  }

  function syncRepoFromPayload(repoPayload, installationId) {
    if (!repoPayload?.full_name) return null;
    const [owner, name] = repoPayload.full_name.split("/");
    return upsertScmRepo({
      externalId: repoPayload.id,
      owner,
      name,
      fullName: repoPayload.full_name,
      // installation_repositories payloads omit clone_url; derive it.
      cloneUrl: repoPayload.clone_url || `https://github.com/${repoPayload.full_name}.git`,
      ...(repoPayload.default_branch ? { defaultBranch: repoPayload.default_branch } : {}),
      private: Boolean(repoPayload.private),
      installationId
    });
  }

  async function routeEvent(event, payload, meta) {
    if (event === "ping") return { status: "ignored", reason: "ping" };

    if (event === "installation") {
      const statusByAction = {
        created: "active",
        unsuspend: "active",
        new_permissions_accepted: "active",
        suspend: "suspended",
        deleted: "removed"
      };
      const status = statusByAction[payload.action];
      if (!status) return { status: "ignored", reason: `installation action '${payload.action}'` };
      syncInstallationFromPayload(payload, status);
      const installationId = payload.installation?.id;
      for (const repoPayload of payload.repositories || []) {
        syncRepoFromPayload(repoPayload, status === "removed" ? "" : installationId);
      }
      return { status: "accepted", outcome: `installation ${payload.action}` };
    }

    if (event === "installation_repositories") {
      syncInstallationFromPayload(payload, "active");
      const installationId = payload.installation?.id;
      for (const repoPayload of payload.repositories_added || []) {
        syncRepoFromPayload(repoPayload, installationId);
      }
      for (const repoPayload of payload.repositories_removed || []) {
        const existing = getScmRepo(repoPayload?.full_name || "");
        if (existing) {
          // The installation lost access: CI must stop firing for it, but
          // the row (history, pipelines) is preserved.
          setScmRepoEnabled(existing.id, false);
          upsertScmRepo({ fullName: existing.fullName, installationId: "" });
        }
      }
      return { status: "accepted", outcome: "installation repositories synced" };
    }

    if (event === "push") {
      const trigger = extractPushTrigger(payload, meta);
      return ciTriggers.createPipelineForTrigger(trigger);
    }

    if (event === "pull_request") {
      if (!SUPPORTED_PR_ACTIONS.includes(payload.action)) {
        return { status: "ignored", reason: `pull_request action '${payload.action}'` };
      }
      const trigger = extractPullRequestTrigger(payload, meta);
      if (trigger.draft && payload.action !== "ready_for_review") {
        return { status: "ignored", reason: "draft pull request" };
      }
      return ciTriggers.createPipelineForTrigger(trigger);
    }

    if (event === "check_run") {
      if (payload.action !== "rerequested") return { status: "ignored", reason: `check_run action '${payload.action}'` };
      if (String(payload.check_run?.app?.id || "") !== String(env.githubAppId)) {
        return { status: "ignored", reason: "check owned by another app" };
      }
      return ciTriggers.handleCheckRerequested(payload);
    }

    return { status: "ignored", reason: `unsupported event '${event}'` };
  }

  return {
    counters,

    // POST /api/ci/webhooks/github — unauthenticated; the HMAC signature IS
    // the authentication. req.body is the RAW Buffer (path-scoped express.raw
    // in src/httpMiddleware.js) so verification covers the exact bytes.
    async githubWebhook(req, res) {
      if (!githubApp.configured()) {
        return res.status(503).json({ error: "GitHub App is not configured on this hub" });
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
      if (!rawBody?.length) return res.status(400).json({ error: "empty body" });

      const signature = req.headers["x-hub-signature-256"];
      if (!verifyGithubWebhookSignature({ secret: env.githubWebhookSecret, rawBody, signatureHeader: signature })) {
        counters.signatureFailures += 1;
        recordAudit("github-webhook", "ci.webhook.signature_failed", null, {
          event: String(req.headers["x-github-event"] || ""),
          deliveryId: String(req.headers["x-github-delivery"] || "")
        });
        return res.status(401).json({ error: "invalid signature" });
      }

      const event = String(req.headers["x-github-event"] || "");
      const deliveryId = String(req.headers["x-github-delivery"] || "");
      if (!deliveryId) return res.status(400).json({ error: "missing x-github-delivery" });

      const hash = payloadHash(rawBody);
      const existing = findScmWebhookDelivery(deliveryId);
      if (existing) {
        if (existing.payloadHash === hash) {
          // Replay-safe acknowledgement: same delivery, same bytes.
          counters.duplicates += 1;
          return res.json({ status: "duplicate", deliveryId, original: existing.status });
        }
        counters.conflicts += 1;
        recordAudit("github-webhook", "ci.webhook.delivery_conflict", deliveryId, { event });
        return res.status(409).json({ error: "delivery id replayed with different payload" });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "invalid JSON payload" });
      }

      const action = String(payload.action || "");
      const repoFullName = payload.repository?.full_name || "";
      let outcome;
      try {
        outcome = await routeEvent(event, payload, { deliveryId, receivedAt: nowIso() });
      } catch (error) {
        logError(`GitHub webhook ${event} handler failed:`, error.message);
        outcome = { status: "error", reason: String(error.message || "handler failed").slice(0, 500) };
      }

      const ledgerStatus = ["accepted", "ignored", "invalid"].includes(outcome.status) ? outcome.status : "error";
      counters[ledgerStatus === "error" ? "errors" : ledgerStatus] += 1;
      if (ledgerStatus === "error") {
        // Deliberately NOT written to the dedupe ledger: GitHub's redelivery
        // of a failed handling must reprocess, not be swallowed as duplicate.
        recordAudit("github-webhook", "ci.webhook.error", deliveryId, {
          event,
          reason: String(outcome.reason || "").slice(0, 500)
        });
      } else {
        try {
          recordScmWebhookDelivery({
            deliveryId,
            event,
            action,
            payloadHash: hash,
            repoFullName,
            status: ledgerStatus,
            detail: {
              ...(outcome.reason ? { reason: String(outcome.reason).slice(0, 500) } : {}),
              ...(outcome.outcome ? { outcome: outcome.outcome } : {})
            },
            pipelineId: outcome.pipelineId || null
          });
        } catch (error) {
          // A ledger race (concurrent identical delivery) must not fail the
          // request after side effects happened.
          logError("webhook ledger write failed:", error.message);
        }
      }

      if (outcome.pipelineId) {
        try {
          advancePipeline(outcome.pipelineId);
        } catch (error) {
          logError("post-webhook advance failed:", error.message);
        }
        syncChecksSoon();
      }

      if (outcome.status === "error") {
        // 500 => GitHub redelivers; the handler is replay-safe by dedupe.
        return res.status(500).json({ error: outcome.reason || "webhook handling failed" });
      }
      return res.json({ status: outcome.status, deliveryId, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.pipelineId ? { pipelineId: outcome.pipelineId, runId: outcome.runId } : {}) });
    }
  };
}
