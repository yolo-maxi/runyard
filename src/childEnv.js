// Child-process environment allowlist.
//
// A launched Smithers workflow (`smithers up`) and the agent it drives run
// arbitrary, potentially untrusted code. Historically the runner spread its
// ENTIRE process.env into that child, which leaks whatever secrets the runner
// happens to carry — the secrets-store master key (SECRETS_ENC_KEY), the Hub
// session secret and bootstrap token, approval-channel tokens, the runner's own
// provider API keys — into workflow/agent code that has no business seeing them.
//
// Instead we pass only the OS/toolchain baseline a child needs to run at all.
// Everything a workflow legitimately needs beyond that reaches it through the
// EXPLICIT channels the launch code already uses: the Hub-injected, allowlisted
// per-run `secretEnv`, the Hub URL/token, and the run identifiers.
// Ambient passthrough of the host's environment is exactly the leak we close.
export const CHILD_ENV_ALLOWLIST = new Set([
  // Process/runtime basics — the shell and toolchain don't run without these.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "HOSTNAME",
  "TZ",
  // Locale.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  // Temp dirs.
  "TMPDIR",
  "TMP",
  "TEMP",
  // TLS trust roots — outbound HTTPS (agent API calls, git over https) breaks
  // without these on hosts that use a custom CA bundle.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // Config/cache/data homes agent CLIs (claude, codex) use to find their config.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA"
]);

export const CHILD_REPO_CONFIG_ALLOWLIST = new Set([
  "GATED_REPO_DIR",
  "IMPROVE_ALLOWED_REPO_ROOTS",
  "IMPROVE_PROJECT_MAP",
  "IMPROVE_REPO_DIR",
  "IMPROVE_REPO_MAP",
  "RUNYARD_REPO_DIR",
  "SMITHERS_REPO_CATALOG"
]);

// Harness/provider SELECTION config the workflow templates read from their own
// process env: which agent CLI drives a workflow (claude/codex/pi), which model,
// and — for the Pi harness — the custom-endpoint descriptor (provider label,
// model, endpoint URL, and the NAME of the env var carrying the API key).
// These are labels and names, never credentials: `..._PI_API_KEY_ENV` holds the
// key's variable name, and the key itself still only reaches the child through
// the Hub's encrypted per-run secretEnv channel. Anything ending in API_KEY,
// TOKEN, or SECRET deliberately matches none of these patterns.
//
// The run-scoped names (RUNYARD_RUN_AGENT_CLI, RUNYARD_RUN_PI_*) are normally
// injected per launch via the runner's runEnv channel (src/runHarnessSelection.js),
// not read from the runner host env; they match the workflow-scoped patterns
// below ("RUN" as the workflow segment), which is why "RUN" is a reserved
// workflow key.
export const CHILD_ENV_ALLOWLIST_PATTERNS = [
  /^RUNYARD_(?:[A-Z0-9]+(?:_[A-Z0-9]+)*_)?AGENT_CLI$/,
  /^RUNYARD_(?:[A-Z0-9]+(?:_[A-Z0-9]+)*_)?(?:AGENT|CLAUDE|CODEX|PI)_MODEL$/,
  /^RUNYARD_(?:[A-Z0-9]+(?:_[A-Z0-9]+)*_)?PI_(?:PROVIDER|BASE_URL|API_KEY_ENV)$/
];

// Return only the allowlisted entries of `baseEnv`. Undefined values are dropped
// so an unset variable never becomes the string "undefined" in the child.
export function allowlistedBaseEnv(
  baseEnv = process.env,
  allowlist = CHILD_ENV_ALLOWLIST,
  patterns = CHILD_ENV_ALLOWLIST_PATTERNS
) {
  const out = {};
  for (const key of allowlist) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of CHILD_REPO_CONFIG_ALLOWLIST) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || key in out) continue;
    if (patterns.some((pattern) => pattern.test(key))) out[key] = value;
  }
  return out;
}
