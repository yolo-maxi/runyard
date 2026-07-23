// package.json version WITHOUT importing env.js — env.js has import-time side
// effects (data-dir resolution, secret derivation) that lightweight child
// processes like the stdio MCP server and the runner must not trigger.
import { readFileSync } from "node:fs";

export const packageVersion = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// The pinned smithers-orchestrator engine version (the source of truth every
// other pin surface is tested against — see tests/smithers-version-pins.test.js).
// The runner compares this against the ENGINE VERSION THAT ACTUALLY EXECUTES:
// since 0.27 the global `smithers` binary delegates to the nearest
// project-local install (a workspace `.smithers/node_modules` pack wins), so
// the binary on PATH proves nothing about what runs.
export const pinnedSmithersVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.dependencies?.["smithers-orchestrator"] || "").replace(/^[\^~]/, "");
  } catch {
    return "";
  }
})();
