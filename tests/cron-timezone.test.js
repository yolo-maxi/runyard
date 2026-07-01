import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidTimezone,
  zonedParts,
  zonedToInstant
} from "../src/cronTimezone.js";

test("validates IANA timezones and treats empty as UTC", () => {
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone(""), true);
  assert.equal(isValidTimezone("Mars/Base"), false);
});

test("returns UTC wall-clock parts without Intl conversion", () => {
  assert.deepEqual(zonedParts(new Date("2026-06-22T10:15:30.000Z"), "UTC"), {
    year: 2026,
    month: 6,
    day: 22,
    hour: 10,
    minute: 15,
    second: 30
  });
});

test("converts zoned wall-clock time to an absolute instant", () => {
  const instant = zonedToInstant(2026, 6, 23, 0, 0, 0, "America/New_York");
  assert.equal(new Date(instant).toISOString(), "2026-06-23T04:00:00.000Z");
});
