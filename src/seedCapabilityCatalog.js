// Seeded entries are Smithers workflows. `workflow.entry` is the workflow file (relative to a
// runner's .smithers workspace); the runner executes `smithers up <entry>` so the local
// Claude Code / Codex CLI does the real work and the Hub records events, traces, and outputs.
import { seedCoreCapabilities } from "./seedCapabilityCore.js";
import { seedProductCapabilities } from "./seedCapabilityProduct.js";
import { seedInternalCapabilities } from "./seedCapabilityInternal.js";

export const seedCapabilities = [
  ...seedCoreCapabilities,
  ...seedProductCapabilities,
  ...seedInternalCapabilities
];
