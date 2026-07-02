#!/usr/bin/env node

console.warn(
  "[runyard] Temporary Smithers dependency: package.json links smithers-orchestrator to ../smithers/packages/smithers. " +
    "Before publishing or release builds, replace it with the latest published Smithers version."
);
