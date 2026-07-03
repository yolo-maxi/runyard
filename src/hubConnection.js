// Canonical hub URL/token resolution — the one fallback chain shared by every
// process that talks to a Hub (runner, MCP server, CLI, warm support agent).
// Before this module each entrypoint hand-rolled its own subset of the chain,
// so the same environment produced different targets per tool — and one path
// even defaulted to a production hostname. The contract:
//
//   url:   explicit arg → RUNYARD_HUB_URL → SMITHERS_HUB_URL (legacy) →
//          HUB_URL (legacy) → saved remote (CLI login) → http://127.0.0.1:43117
//   token: explicit arg → RUNYARD_HUB_TOKEN → SMITHERS_HUB_TOKEN (legacy) →
//          HUB_TOKEN (legacy) → bootstrap token (opt-in) → saved remote
//
// The default is always loopback: a missing config must never send traffic to
// someone else's hub. Services (the runner) pass no `remote` — a system unit
// must not silently pick up a user's interactive CLI login.

export const DEFAULT_HUB_URL = "http://127.0.0.1:43117";

export function resolveHubUrl({ explicit = "", env = process.env, remote = null } = {}) {
  const url =
    explicit ||
    env.RUNYARD_HUB_URL ||
    env.SMITHERS_HUB_URL ||
    env.HUB_URL ||
    (remote && remote.url) ||
    DEFAULT_HUB_URL;
  return String(url).replace(/\/$/, "");
}

// allowBootstrap: only the runner may fall back to the hub bootstrap token —
// that is how a fresh box's runner authenticates before a scoped token exists.
// Interactive tools must not silently escalate to the bootstrap credential.
export function resolveHubToken({ explicit = "", env = process.env, remote = null, allowBootstrap = false } = {}) {
  return (
    explicit ||
    env.RUNYARD_HUB_TOKEN ||
    env.SMITHERS_HUB_TOKEN ||
    env.HUB_TOKEN ||
    (allowBootstrap ? env.RUNYARD_HUB_BOOTSTRAP_TOKEN || env.SMITHERS_HUB_BOOTSTRAP_TOKEN : "") ||
    (remote && remote.token) ||
    ""
  );
}
