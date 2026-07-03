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
