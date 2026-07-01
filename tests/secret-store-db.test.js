import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSecretStore } from "../src/secretStore.js";

const metaRow = {
  key: "API_TOKEN",
  description: "token",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  created_by: "admin"
};

function createHarness({ oneRows = [metaRow], allRows = [metaRow], enabled = true, decrypt = (value) => `plain:${value}` } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createSecretStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : metaRow;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    now: () => "2026-07-01T00:00:00.000Z",
    encrypt: (value) => `enc:${value}`,
    decrypt,
    redactSecrets: (value, secrets) => JSON.stringify({ value, secrets }),
    secretsEnabled: () => enabled
  });
  return { calls, store };
}

describe("secret DB store", () => {
  it("lists metadata and checks existence without decrypting values", () => {
    const { store } = createHarness();

    assert.equal(store.listSecretMeta()[0].key, "API_TOKEN");
    assert.equal(store.secretExists("API_TOKEN"), true);
    assert.equal(store.getSecretMeta("API_TOKEN").description, "token");
  });

  it("inserts and updates encrypted secrets without persisting plaintext", () => {
    const insert = createHarness({ oneRows: [null, metaRow] });
    assert.equal(insert.store.upsertSecret({
      key: "API_TOKEN",
      value: "secret",
      description: "token",
      createdBy: "admin"
    }).key, "API_TOKEN");
    assert.equal(insert.calls.find((call) => call.fn === "run").params[1], "enc:secret");

    const update = createHarness({ oneRows: [metaRow, metaRow] });
    update.store.upsertSecret({ key: "API_TOKEN", value: "next" });
    assert.equal(update.calls.find((call) => call.fn === "run").params[0], "enc:next");
  });

  it("deletes secrets and returns false for unchanged deletes", () => {
    const deleted = createSecretStore({
      ...createHarness().store,
      all: () => [],
      one: () => null,
      run: () => ({ changes: 0 }),
      now: () => "now",
      encrypt: String,
      decrypt: String,
      redactSecrets: (value) => value,
      secretsEnabled: () => true
    });

    assert.equal(deleted.deleteSecret("API_TOKEN"), false);
  });

  it("decrypts only unique requested names and skips bad rows", () => {
    const { store } = createHarness({
      oneRows: [
        { value_encrypted: "A" },
        { value_encrypted: "bad" }
      ],
      decrypt: (value) => {
        if (value === "bad") throw new Error("bad key");
        return `plain:${value}`;
      }
    });

    assert.deepEqual(store.getDecryptedSecretEnv([" API_TOKEN ", "API_TOKEN", "BROKEN"]), {
      API_TOKEN: "plain:A"
    });
  });

  it("disables decryption and scrubbing when the encrypted store is disabled", () => {
    const { calls, store } = createHarness({ enabled: false });

    assert.deepEqual(store.getDecryptedSecretEnv(["API_TOKEN"]), {});
    assert.deepEqual(store.allSecretValues(), []);
    assert.equal(store.scrubStoredSecrets("hello"), "hello");
    assert.equal(calls.length, 0);
  });

  it("scrubs stored secret values and skips undecryptable values", () => {
    const { store } = createHarness({
      allRows: [{ value_encrypted: "A" }, { value_encrypted: "bad" }],
      decrypt: (value) => {
        if (value === "bad") throw new Error("bad key");
        return `plain:${value}`;
      }
    });

    assert.equal(store.scrubStoredSecrets("hello"), JSON.stringify({
      value: "hello",
      secrets: ["plain:A"]
    }));
  });
});
