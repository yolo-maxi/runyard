import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliverHttpResponseEndpoint,
  deliverResponseEndpointTransport,
  deliverTelegramResponseEndpoint,
  postJson,
  safeResponseEndpointError,
  telegramTerminalMessage
} from "../src/runResponseEndpointTransports.js";

function response({ ok = true, status = 200 } = {}) {
  return { ok, status };
}

describe("run response endpoint transports", () => {
  it("posts JSON with timeout support and extra headers", async () => {
    const calls = [];
    const result = await postJson("https://example.test/hook", { ok: true }, { method: "PUT" }, {
      timeoutMs: 1000,
      headers: { "x-test": "1" },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({ status: 202 });
      }
    });

    assert.deepEqual(result, { ok: true, status: 202 });
    assert.equal(calls[0].url, "https://example.test/hook");
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.equal(calls[0].init.headers["x-test"], "1");
    assert.deepEqual(JSON.parse(calls[0].init.body), { ok: true });
  });

  it("delivers HTTP endpoints and redacts transport errors", async () => {
    assert.deepEqual(await deliverHttpResponseEndpoint(
      { type: "http", config: { url: "https://example.test", method: "GET" } },
      {},
      { timeoutMs: 1000, fetchImpl: async () => response() }
    ), { ok: false, error: "unsupported http method: GET" });

    const result = await deliverHttpResponseEndpoint(
      { type: "http", config: { url: "https://example.test", method: "POST" } },
      {},
      {
        timeoutMs: 1000,
        fetchImpl: async () => {
          throw new Error("failed token=shub_secret");
        }
      }
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /shub_secret/);
    assert.match(result.error, /\[redacted\]/);
  });

  it("builds and delivers Telegram messages", async () => {
    const run = { id: "run_1", status: "failed", capabilityName: "Deploy" };
    const payload = { error: "boom", artifacts: [{ id: "artifact_1" }] };
    assert.equal(
      telegramTerminalMessage(run, payload, "https://hub.test"),
      "Runyard: Deploy\nRun run_1 → FAILED\nError: boom\nArtifacts: 1\nhttps://hub.test/app#runs/run_1"
    );

    const calls = [];
    const delivered = await deliverTelegramResponseEndpoint(
      { type: "telegram", config: { chatId: "123", threadId: 45, parseMode: "Markdown" } },
      run,
      payload,
      {
        timeoutMs: 1000,
        telegramBotToken: "bot-token",
        baseUrl: "https://hub.test",
        fetchImpl: async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return response({ status: 200 });
        }
      }
    );

    assert.deepEqual(delivered, { ok: true, status: 200 });
    assert.equal(calls[0].url, "https://api.telegram.org/botbot-token/sendMessage");
    assert.equal(calls[0].body.chat_id, "123");
    assert.equal(calls[0].body.message_thread_id, 45);
    assert.equal(calls[0].body.parse_mode, "Markdown");
  });

  it("dispatches by endpoint type and reports unknown transports", async () => {
    assert.deepEqual(await deliverResponseEndpointTransport(
      { type: "unknown", config: {} },
      {},
      {},
      { fetchImpl: async () => response() }
    ), { ok: false, error: "unknown response endpoint type: unknown" });
    assert.match(safeResponseEndpointError("token=shub_secret"), /\[redacted\]/);
  });
});
