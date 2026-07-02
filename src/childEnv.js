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
// per-run `secretEnv`, the supervisor hub URL/token, and the run identifiers.
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

// Return only the allowlisted entries of `baseEnv`. Undefined values are dropped
// so an unset variable never becomes the string "undefined" in the child.
export function allowlistedBaseEnv(baseEnv = process.env, allowlist = CHILD_ENV_ALLOWLIST) {
  const out = {};
  for (const key of allowlist) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
