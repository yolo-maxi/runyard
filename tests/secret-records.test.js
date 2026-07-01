import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allSecretEncryptedValuesQuery,
  cleanSecretKey,
  normalizeSecretMeta,
  secretDeleteQuery,
  secretEncryptedValueQuery,
  secretExistingMetaQuery,
  secretInsertQuery,
  secretKeyQuery,
  secretMetaListQuery,
  secretMetaQuery,
  secretUpdateQuery,
  secretUpsertParams,
  uniqueSecretNames
} from "../src/secretRecords.js";

describe("secret record helpers", () => {
  it("normalizes keys and metadata rows", () => {
    assert.equal(cleanSecretKey("  API_TOKEN  "), "API_TOKEN");
    assert.equal(cleanSecretKey(null), "");

    assert.equal(normalizeSecretMeta(null), null);
    assert.deepEqual(normalizeSecretMeta({
      key: "API_TOKEN",
      description: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      created_by: null
    }), {
      key: "API_TOKEN",
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      createdBy: ""
    });
  });

  it("builds secret upsert parameters without exposing plaintext", () => {
    assert.deepEqual(secretUpsertParams({
      key: "  TOKEN  ",
      encryptedValue: "encrypted-blob",
      description: null,
      createdBy: 42,
      timestamp: "2026-01-01T00:00:00.000Z"
    }), {
      key: "TOKEN",
      valueEncrypted: "encrypted-blob",
      description: "",
      createdBy: "42",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
  });

  it("dedupes and trims allowlisted secret names", () => {
    assert.deepEqual(uniqueSecretNames([" A ", "", "B", "A", null]), ["A", "B"]);
    assert.deepEqual(uniqueSecretNames("A"), []);
  });

  it("builds secret metadata and encrypted-value queries", () => {
    assert.deepEqual(secretMetaListQuery(), {
      sql: "SELECT key, description, created_at, updated_at, created_by FROM secrets ORDER BY key",
      params: []
    });
    assert.deepEqual(secretKeyQuery(" TOKEN "), {
      sql: "SELECT key FROM secrets WHERE key = ?",
      params: ["TOKEN"]
    });
    assert.deepEqual(secretExistingMetaQuery(" TOKEN "), {
      sql: "SELECT key, created_at, created_by FROM secrets WHERE key = ?",
      params: ["TOKEN"]
    });
    assert.deepEqual(secretMetaQuery(" TOKEN "), {
      sql: "SELECT key, description, created_at, updated_at, created_by FROM secrets WHERE key = ?",
      params: ["TOKEN"]
    });
    assert.deepEqual(secretEncryptedValueQuery(" TOKEN "), {
      sql: "SELECT value_encrypted FROM secrets WHERE key = ?",
      params: ["TOKEN"]
    });
    assert.deepEqual(allSecretEncryptedValuesQuery(), {
      sql: "SELECT value_encrypted FROM secrets",
      params: []
    });
  });

  it("builds secret write queries from sanitized payloads", () => {
    const payload = secretUpsertParams({
      key: "TOKEN",
      encryptedValue: "encrypted",
      description: "desc",
      createdBy: "admin",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(secretUpdateQuery(payload), {
      sql: "UPDATE secrets SET value_encrypted = ?, description = ?, updated_at = ? WHERE key = ?",
      params: ["encrypted", "desc", "2026-01-01T00:00:00.000Z", "TOKEN"]
    });
    assert.deepEqual(secretInsertQuery(payload), {
      sql: "INSERT INTO secrets (key, value_encrypted, description, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      params: ["TOKEN", "encrypted", "desc", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "admin"]
    });
    assert.deepEqual(secretDeleteQuery(" TOKEN "), {
      sql: "DELETE FROM secrets WHERE key = ?",
      params: ["TOKEN"]
    });
  });
});
