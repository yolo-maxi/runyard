import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShapeMessages } from "../web/lib/shapeProtocol.js";

test("classifies insert/update/delete operations", () => {
  const { ops, upToDate, mustRefetch } = classifyShapeMessages([
    { headers: { operation: "insert" }, key: "1", value: { id: "1" } },
    { headers: { operation: "update" }, key: "1", value: { id: "1", status: "done" } },
    { headers: { operation: "delete" }, key: "2", value: { id: "2" } }
  ]);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0], { operation: "insert", key: "1", value: { id: "1" } });
  assert.equal(ops[2].operation, "delete");
  assert.equal(upToDate, false);
  assert.equal(mustRefetch, false);
});

test("detects the up-to-date control message", () => {
  const { ops, upToDate } = classifyShapeMessages([
    { headers: { operation: "insert" }, key: "1", value: { id: "1" } },
    { headers: { control: "up-to-date" } }
  ]);
  assert.equal(ops.length, 1);
  assert.equal(upToDate, true);
});

test("must-refetch short-circuits and drops preceding ops", () => {
  const { ops, mustRefetch } = classifyShapeMessages([
    { headers: { operation: "insert" }, key: "1", value: { id: "1" } },
    { headers: { control: "must-refetch" } },
    { headers: { operation: "insert" }, key: "2", value: { id: "2" } }
  ]);
  assert.equal(mustRefetch, true);
  assert.equal(ops.length, 1);
});

test("ignores snapshot-end and empty pages", () => {
  assert.deepEqual(classifyShapeMessages([{ headers: { control: "snapshot-end" } }]), {
    ops: [],
    upToDate: false,
    mustRefetch: false
  });
  assert.deepEqual(classifyShapeMessages([]), { ops: [], upToDate: false, mustRefetch: false });
  assert.deepEqual(classifyShapeMessages(null), { ops: [], upToDate: false, mustRefetch: false });
});
