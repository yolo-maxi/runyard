import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRON_ALIASES,
  isParsedCronSpec,
  normalizeCronExpression,
  parseCron
} from "../src/cronParser.js";

describe("cron parser helpers", () => {
  it("normalizes aliases and rejects unknown aliases", () => {
    assert.equal(CRON_ALIASES["@hourly"], "0 * * * *");
    assert.deepEqual(normalizeCronExpression("@daily"), { raw: "@daily", normalized: "0 0 * * *" });
    assert.throws(() => normalizeCronExpression("@sometimes"), /unknown cron alias/);
  });

  it("parses ranges, steps, names, and Sunday aliases into matcher sets", () => {
    const spec = parseCron("*/15 9-17/2 * jan,mar mon-fri");
    assert.deepEqual([...spec.minute], [0, 15, 30, 45]);
    assert.deepEqual([...spec.hour], [9, 11, 13, 15, 17]);
    assert.deepEqual([...spec.month], [1, 3]);
    assert.deepEqual([...spec.dow], [1, 2, 3, 4, 5]);
    assert.equal(spec.domRestricted, false);
    assert.equal(spec.dowRestricted, true);

    assert.deepEqual([...parseCron("0 0 * * 7").dow], [0]);
  });

  it("reports malformed fields with useful errors", () => {
    assert.throws(() => parseCron("0 0 * *"), /expected 5 cron fields/);
    assert.throws(() => parseCron("99 * * * *"), /out of range/);
    assert.throws(() => parseCron("*/0 * * * *"), /invalid step/);
    assert.equal(isParsedCronSpec(parseCron("0 0 * * *")), true);
    assert.equal(isParsedCronSpec({}), false);
  });
});
