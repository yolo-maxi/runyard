// Runner-side half of the metering-gateway pin.
//
// A gateway-pinned claim ships {path, provider, model, tokenEnv, token}
// instead of the provider key. The runner materializes a PER-RUN pi agent
// config directory whose models.json contains ONLY the gateway provider —
// pointing at the Hub — and steers the child there via PI_CODING_AGENT_DIR
// (the pi CLI's agent-dir override). The child can name no other provider and
// holds no provider key; its single credential is the run-scoped gateway
// token, which the Hub only honors while this run is active.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const GATEWAY_MODEL_CONTEXT_WINDOW = 128_000;
const GATEWAY_MODEL_MAX_TOKENS = 16_384;

export function gatewayBaseUrl(gateway, hubUrl) {
  return `${String(hubUrl || "").replace(/\/+$/, "")}${gateway.path}`;
}

// The pi models.json for a pinned run: one provider, one model, key by
// $ENV reference (never inline).
export function piGatewayModelsConfig(gateway, hubUrl) {
  return {
    providers: {
      [gateway.provider]: {
        name: "RunYard metering gateway",
        baseUrl: gatewayBaseUrl(gateway, hubUrl),
        api: "openai-completions",
        apiKey: `$${gateway.tokenEnv}`,
        models: [
          {
            id: gateway.model,
            name: gateway.model,
            contextWindow: GATEWAY_MODEL_CONTEXT_WINDOW,
            maxTokens: GATEWAY_MODEL_MAX_TOKENS
          }
        ]
      }
    }
  };
}

// Child-env overrides for a pinned run. Ride the runEnv channel LAST so they
// outrank the run's own harness selection — the pin replaces the endpoint the
// run asked for; the Hub forwards to that endpoint server-side instead.
export function gatewayPinEnv(gateway, { hubUrl, agentDir }) {
  return {
    PI_CODING_AGENT_DIR: agentDir,
    [gateway.tokenEnv]: gateway.token,
    RUNYARD_RUN_AGENT_CLI: "pi",
    RUNYARD_RUN_PI_PROVIDER: gateway.provider,
    RUNYARD_RUN_PI_MODEL: gateway.model,
    RUNYARD_RUN_PI_BASE_URL: gatewayBaseUrl(gateway, hubUrl),
    RUNYARD_RUN_PI_API_KEY_ENV: gateway.tokenEnv
  };
}

export function gatewayAgentDir(workspace, runId) {
  return path.join(workspace, ".smithers", "gateway", String(runId));
}

// Write the per-run agent dir and return the env overrides for launch.
export function materializeGatewayPin({ workspace, runId, gateway, hubUrl, mkdir = mkdirSync, writeFile = writeFileSync }) {
  if (!gateway?.path || !gateway?.provider || !gateway?.model || !gateway?.token || !gateway?.tokenEnv) {
    throw new Error("gateway pin payload is incomplete (path/provider/model/token/tokenEnv required)");
  }
  const agentDir = gatewayAgentDir(workspace, runId);
  mkdir(agentDir, { recursive: true });
  writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(piGatewayModelsConfig(gateway, hubUrl), null, 2)}\n`);
  return gatewayPinEnv(gateway, { hubUrl, agentDir });
}
