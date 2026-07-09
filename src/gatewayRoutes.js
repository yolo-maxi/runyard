// Metering-gateway HTTP handlers: provider-shaped proxy endpoints pinned into
// gateway-metered runs. The child agent speaks the provider's own wire API to
// the Hub; the Hub authenticates the per-run gateway token, enforces the run
// budget BEFORE forwarding, calls the real upstream with the Hub-held key,
// streams the response back untouched, and records usage from the provider's
// own response metadata — the inference boundary, not log scraping.
import {
  anthropicUsage,
  gatewayRequestToken,
  openAiUsage,
  sseUsage,
  verifyGatewayToken
} from "./meteringGateway.js";
import { resolveHarnessSelection } from "./runHarnessSelection.js";
import { pauseSignalFromProviderResponse } from "./runPause.js";

// A gateway call is only valid while the run is actually executing on a
// runner. Terminal runs (incl. budget_exceeded) get a hard 403 — that is the
// hard stop for a child that ignores cancellation.
const ACTIVE_RUN_STATUSES = new Set(["assigned", "running"]);

// Buffered-SSE scan cap. Streams larger than this still proxy through in
// full; only the usage scan window is bounded (usage rides the final frames,
// so keep the tail).
const SSE_SCAN_MAX_BYTES = 4_000_000;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;

function errorBody(flavor, message, type = "budget_exceeded") {
  if (flavor === "anthropic") return { type: "error", error: { type, message } };
  return { error: { message, type } };
}

export function createGatewayHandlers({
  env,
  processEnv = process.env,
  getRun,
  getCapability,
  getDecryptedSecretEnv,
  recordRunUsage,
  enforceRunBudget,
  pauseRun = () => ({ ok: false }),
  fetchImpl = fetch,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  log = console.error
}) {
  function authenticateGatewayRun(req, res, flavor) {
    const runId = verifyGatewayToken(gatewayRequestToken(req), env.sessionSecret);
    if (!runId) {
      res.status(401).json(errorBody(flavor, "invalid or missing gateway token", "authentication_error"));
      return null;
    }
    const run = getRun(runId);
    if (!run) {
      res.status(401).json(errorBody(flavor, "gateway token does not match a known run", "authentication_error"));
      return null;
    }
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      res.status(403).json(errorBody(flavor, `run is ${run.status}; gateway calls are only served while it executes`, "run_not_active"));
      return null;
    }
    return run;
  }

  function upstreamFor(run, flavor) {
    const capability = getCapability(run.capabilitySlug);
    const { selection } = resolveHarnessSelection({ capability, input: run.input || {} });
    if (flavor === "anthropic") {
      const baseUrl = String(processEnv.RUNYARD_GATEWAY_ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
      const secretEnv = getDecryptedSecretEnv(["ANTHROPIC_API_KEY"]);
      return {
        url: `${baseUrl}/v1/messages`,
        apiKey: secretEnv.ANTHROPIC_API_KEY || processEnv.ANTHROPIC_API_KEY || "",
        provider: "anthropic"
      };
    }
    // OpenAI-compatible: the run's own pi endpoint selection is the upstream —
    // the child was pinned to the gateway INSTEAD of that endpoint.
    const baseUrl = String(selection.piBaseUrl || processEnv.RUNYARD_GATEWAY_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    let apiKey = "";
    if (selection.piApiKeyEnv) {
      const secretEnv = getDecryptedSecretEnv([selection.piApiKeyEnv]);
      apiKey = secretEnv[selection.piApiKeyEnv] || processEnv[selection.piApiKeyEnv] || "";
    }
    if (!apiKey) apiKey = processEnv.OPENAI_API_KEY || "";
    return {
      url: `${baseUrl}/chat/completions`,
      apiKey,
      provider: selection.piProvider || "openai"
    };
  }

  // The gateway is the one place the Hub sees the provider's raw response, so
  // an upstream "no credits/quota" answer becomes a structured pause here —
  // the run parks as resumable `paused` instead of dying on a scraped stderr
  // line. Distinct from the Hub's OWN pre-forward 402 (budget_exceeded), which
  // never reaches this hook and stays a terminal hard stop.
  function maybePauseOnProviderSignal(run, status, bodyText) {
    const signal = pauseSignalFromProviderResponse({ status, bodyText });
    if (!signal) return;
    const result = pauseRun(run.id, {
      reason: signal.reason,
      message: signal.message,
      pausedBy: "gateway",
      resumable: true
    });
    if (result.ok) log(`gateway paused run ${run.id}: ${signal.reason} (upstream ${status})`);
  }

  async function proxyCall(req, res, { flavor, requestHeaders }) {
    const run = authenticateGatewayRun(req, res, flavor);
    if (!run) return;

    const pre = enforceRunBudget(run);
    if (pre.exceeded) {
      res.status(402).json(errorBody(flavor, pre.reason || "run budget exceeded"));
      return;
    }

    const upstream = upstreamFor(run, flavor);
    if (!upstream.apiKey) {
      res.status(502).json(errorBody(flavor, "no upstream provider key is configured on the hub for this run", "gateway_config_error"));
      return;
    }

    let response;
    try {
      response = await fetchImpl(upstream.url, {
        method: "POST",
        headers: requestHeaders(upstream, req),
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(upstreamTimeoutMs)
      });
    } catch (error) {
      log(`gateway upstream call failed for ${run.id}:`, error.message);
      res.status(502).json(errorBody(flavor, "upstream provider call failed", "gateway_upstream_error"));
      return;
    }

    const contentType = response.headers.get("content-type") || "application/json";
    let usage = null;
    if (contentType.includes("text/event-stream")) {
      res.status(response.status);
      res.set("content-type", contentType);
      res.flushHeaders?.();
      let scanBuffer = "";
      try {
        for await (const chunk of response.body) {
          res.write(chunk);
          if (scanBuffer.length < SSE_SCAN_MAX_BYTES) scanBuffer += Buffer.from(chunk).toString("utf8");
        }
      } catch (error) {
        log(`gateway stream from upstream broke for ${run.id}:`, error.message);
      }
      res.end();
      if (response.ok) usage = sseUsage(scanBuffer, flavor);
      else maybePauseOnProviderSignal(run, response.status, scanBuffer);
    } else {
      const text = await response.text();
      res.status(response.status);
      res.set("content-type", contentType);
      res.send(text);
      if (response.ok) {
        try {
          usage = flavor === "anthropic" ? anthropicUsage(JSON.parse(text)) : openAiUsage(JSON.parse(text));
        } catch {
          usage = null;
        }
      } else {
        maybePauseOnProviderSignal(run, response.status, text);
      }
    }

    if (usage) {
      const { metadata, ...counts } = usage;
      recordRunUsage(run.id, {
        ...counts,
        model: usage.model || String(req.body?.model || "") || "unknown",
        provider: upstream.provider,
        source: "gateway",
        metadata: { ...(metadata || {}), gateway: flavor }
      });
      // Post-call check: stop the run before it can issue the NEXT call.
      enforceRunBudget(run.id);
    } else if (response.ok) {
      log(`gateway response for ${run.id} carried no usage metadata (${flavor}); call proxied but not metered`);
    }
  }

  return {
    async openAiChatCompletions(req, res) {
      await proxyCall(req, res, {
        flavor: "openai",
        requestHeaders: (upstream) => ({
          "content-type": "application/json",
          authorization: `Bearer ${upstream.apiKey}`
        })
      });
    },

    async anthropicMessages(req, res) {
      await proxyCall(req, res, {
        flavor: "anthropic",
        requestHeaders: (upstream, req2) => ({
          "content-type": "application/json",
          "x-api-key": upstream.apiKey,
          "anthropic-version": String(req2.headers["anthropic-version"] || "2023-06-01")
        })
      });
    }
  };
}
