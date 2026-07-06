import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createRunDraftStore } from "../src/runDraftStore.js";
import { mergeRunDraftInput, runDraftIsOpen } from "../src/runDraftRecords.js";

function storeHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec(DB_SCHEMA_SQL);
  let tick = 0;
  let sequence = 0;
  const store = createRunDraftStore({
    all: (sql, params) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params)),
    one: (sql, params) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params)),
    run: (sql, params) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params)),
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => `2026-07-06T00:00:0${tick++}.000Z`,
    scrubStoredSecrets: (value) => {
      const scrubbed = { ...value };
      delete scrubbed.pastedSecret;
      return scrubbed;
    }
  });
  return { store };
}

describe("run draft store", () => {
  it("creates, reads, and lists drafts with scrubbed input", () => {
    const { store } = storeHarness();
    const draft = store.createRunDraft({
      capabilitySlug: "research",
      input: { prompt: "x", pastedSecret: "sk-nope" },
      options: { executionMode: "remote" },
      status: "needs_input",
      preflight: { status: "needs_input", questions: [{ field: "title" }] },
      createdBy: "token: operator"
    });

    assert.match(draft.id, /^draft_/);
    assert.equal(draft.status, "needs_input");
    assert.deepEqual(draft.input, { prompt: "x" });
    assert.deepEqual(draft.options, { executionMode: "remote" });
    assert.equal(draft.preflight.questions.length, 1);
    assert.equal(draft.createdBy, "token: operator");
    assert.equal(draft.runId, null);
    assert.ok(runDraftIsOpen(draft));

    assert.deepEqual(store.getRunDraft(draft.id), draft);
    assert.equal(store.getRunDraft("draft_missing"), null);
    assert.equal(store.listRunDrafts({ capability: "research" }).length, 1);
    assert.equal(store.listRunDrafts({ status: "blocked" }).length, 0);
  });

  it("updates drafts, marks them submitted with the run id, and discards them", () => {
    const { store } = storeHarness();
    const draft = store.createRunDraft({
      capabilitySlug: "research",
      input: {},
      status: "needs_input",
      preflight: { status: "needs_input" }
    });

    const patched = store.updateRunDraft(draft.id, {
      input: { prompt: "quantum" },
      status: "ready",
      preflight: { status: "ready" }
    });
    assert.equal(patched.status, "ready");
    assert.deepEqual(patched.input, { prompt: "quantum" });
    assert.notEqual(patched.updatedAt, draft.updatedAt);

    const submitted = store.markRunDraftSubmitted(draft.id, { runId: "run_9", preflight: { status: "ready" } });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.runId, "run_9");
    assert.ok(!runDraftIsOpen(submitted));

    const other = store.createRunDraft({ capabilitySlug: "hello", input: {}, status: "ready", preflight: {} });
    assert.equal(store.discardRunDraft(other.id).status, "discarded");
    assert.equal(store.updateRunDraft("draft_missing", { status: "ready" }), null);
  });

  it("merges patch input shallowly with null deleting keys", () => {
    assert.deepEqual(
      mergeRunDraftInput({ prompt: "old", depth: 2 }, { prompt: "new", depth: null, title: "T" }),
      { prompt: "new", title: "T" }
    );
    assert.deepEqual(mergeRunDraftInput(undefined, { a: 1 }), { a: 1 });
  });
});
