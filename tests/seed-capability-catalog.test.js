import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seedCapabilities } from "../src/seedCapabilityCatalog.js";
import { seedCoreCapabilities } from "../src/seedCapabilityCore.js";
import { seedInternalCapabilities } from "../src/seedCapabilityInternal.js";
import { seedProductCapabilities } from "../src/seedCapabilityProduct.js";

describe("seed capability catalog", () => {
  it("aggregates domain catalog modules in stable seed order", () => {
    assert.deepEqual(seedCapabilities, [
      ...seedCoreCapabilities,
      ...seedProductCapabilities,
      ...seedInternalCapabilities
    ]);
    assert.deepEqual(seedCapabilities.map((capability) => capability.slug), [
      "hello",
      "runyard-smoke-check",
      "skillmarket-quote-sidecar",
      "skillmarket-package-audit",
      "skillmarket-paid-run",
      "runyard-support-agent",
      "research",
      "implement",
      "smart-contract-audit",
      "docs-update",
      "implement-change-gated",
      "idea-to-product",
      "improve",
      "product-scout",
      "product-workflow",
      "ci-pipeline",
      "ci-job",
      "reauth-cli"
    ]);
  });

  it("keeps seeded capability slugs unique", () => {
    const slugs = seedCapabilities.map((capability) => capability.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });
});
