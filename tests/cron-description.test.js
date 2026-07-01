import test from "node:test";
import assert from "node:assert/strict";

import { describeCron } from "../src/cronDescription.js";
import { describeCron as describeCronFromFacade } from "../src/cron.js";

test("describes common cron schedules", () => {
  assert.equal(describeCron("0 0 * * *"), "Daily at 00:00 UTC");
  assert.equal(describeCron("30 9 * * 1"), "Weekly on Monday at 09:30 UTC");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours");
  assert.equal(describeCron("45 * * * *"), "Hourly at :45");
});

test("includes timezone in descriptions that depend on local time", () => {
  assert.equal(describeCron("0 8 * * *", "America/New_York"), "Daily at 08:00 America/New_York");
  assert.equal(describeCron("5 7 1 1 *", "Europe/London"), "Yearly on January 1 at 07:05 Europe/London");
});

test("reports invalid expressions without throwing", () => {
  assert.match(describeCron("bad input"), /^Invalid schedule \(/);
});

test("keeps describeCron available from the cron facade", () => {
  assert.equal(describeCronFromFacade("0 0 * * *"), "Daily at 00:00 UTC");
});
