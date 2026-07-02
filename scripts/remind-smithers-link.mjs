#!/usr/bin/env node
// Guards against shipping the local `link:` Smithers dependency.
//
// While developing against a sibling Smithers checkout, package.json points the
// smithers packages at `link:../smithers/...`. That form is unpublishable — nobody
// else has that checkout — so it must never reach a release. In everyday dev
// (prestart/prebuild) we only warn; in a release/publish context we FAIL so a
// broken package can't be cut.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const linkedDeps = Object.entries({
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
})
  .filter(([name, spec]) =>
    (name === "smithers-orchestrator" || name.startsWith("@smithers-orchestrator/")) &&
    typeof spec === "string" &&
    spec.startsWith("link:")
  )
  .map(([name, spec]) => `${name} → ${spec}`);

if (linkedDeps.length === 0) {
  process.exit(0);
}

// A release context is any publish lifecycle, an explicit opt-in, or a CI
// release job. `npm_lifecycle_event` is set by npm/pnpm to the running script.
const lifecycle = process.env.npm_lifecycle_event ?? "";
const isReleaseContext =
  process.env.RUNYARD_RELEASE === "1" ||
  /^(prepublishonly|prepublish|prepack|prepare|publish)$/i.test(lifecycle) ||
  (process.env.CI === "true" && /release|publish/i.test(process.env.GITHUB_JOB ?? process.env.CI_JOB_NAME ?? ""));

const detail =
  `package.json links the following Smithers dependencies to a local checkout:\n` +
  linkedDeps.map((d) => `  - ${d}`).join("\n") +
  `\nReplace them with the latest published Smithers version before releasing.`;

if (isReleaseContext) {
  console.error(`[runyard] Refusing to build for release: ${detail}`);
  process.exit(1);
}

console.warn(`[runyard] Temporary Smithers dependency (dev only): ${detail}`);
