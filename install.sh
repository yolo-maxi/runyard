#!/usr/bin/env bash
#
# install.sh — one-command fresh-box bootstrap for a self-hosted RunYard.
#
#   curl -fsSL https://raw.githubusercontent.com/yolo-maxi/runyard/main/install.sh | bash
#
# What it does (all idempotent — safe to re-run):
#   * ensure node 22 + pnpm are present (installs node via NodeSource on apt boxes)
#   * clone RunYard at the latest release tag into $RUNYARD_HOME
#   * install dependencies (pnpm install --frozen-lockfile)
#   * generate a SECRETS_ENC_KEY + a starter env file (never clobbered if present)
#   * create the data/ dir (DB + secrets live here and survive every update)
#   * install + enable the systemd units (hub, and runner unless disabled)
#   * install a daily, passive update-CHECK timer (never auto-applies)
#   * print the Caddy reverse-proxy snippet to add (Caddy is NOT assumed/installed)
#
# It NEVER prints SECRETS_ENC_KEY or any secret. It NEVER applies an update or
# phones home — the only outbound call RunYard makes is the GitHub Releases read.
#
# Tunables (env vars, all optional):
#   RUNYARD_REPO_URL     git URL to clone            (default github.com/yolo-maxi/runyard)
#   RUNYARD_GITHUB_REPO  owner/repo for update check (default yolo-maxi/runyard)
#   RUNYARD_HOME         install dir                 (default /opt/runyard)
#   RUNYARD_ENV_DIR      env-file dir                (default /etc/runyard)
#   RUNYARD_DATA_DIR     data dir                    (default $RUNYARD_HOME/data)
#   RUNYARD_PORT         hub port                    (default 43117)
#   RUNYARD_BASE_URL     public base URL            (default http://<host>:<port>)
#   RUNYARD_SERVICE_USER unix user to run as         (default current/sudo user)
#   RUNYARD_INSTALL_RUNNER  1 to install the runner unit too (default 1)
#   RUNYARD_INSTALL_AGENTS  1 to also install codex/claude/pi/smithers on a runner
#                           (default 0 — opt-in; the UI manages agents, and a
#                           forced global install can stall headless installs)
#   RUNYARD_CODEX_VERSION   pinned @openai/codex version          (default 0.142.2)
#   RUNYARD_CLAUDE_VERSION  pinned @anthropic-ai/claude-code ver  (default 2.1.195)
#   RUNYARD_PI_VERSION      pinned @earendil-works/pi-coding-agent (default 0.80.3)
#   RUNYARD_SMITHERS_VERSION pinned smithers-orchestrator version (default 0.30.0)
#   REAUTH_ENABLED       set to 1 on a dedicated reauth runner host (default empty)
#   UPDATE_CHECK_ENABLED passive update check        (default 1)
set -euo pipefail

REPO_URL="${RUNYARD_REPO_URL:-https://github.com/yolo-maxi/runyard.git}"
GITHUB_REPO="${RUNYARD_GITHUB_REPO:-yolo-maxi/runyard}"
HOME_DIR="${RUNYARD_HOME:-/opt/runyard}"
ENV_DIR="${RUNYARD_ENV_DIR:-/etc/runyard}"
DATA_DIR="${RUNYARD_DATA_DIR:-$HOME_DIR/data}"
PORT="${RUNYARD_PORT:-43117}"
INSTALL_RUNNER="${RUNYARD_INSTALL_RUNNER:-1}"
UPDATE_CHECK_ENABLED="${UPDATE_CHECK_ENABLED:-1}"
REAUTH_ENABLED_VAL="${REAUTH_ENABLED:-}"
# Agent CLIs the runner shells out to. A runner host needs codex/claude/pi/smithers
# on PATH; the hub does not. Pinned for reproducibility; override or set to 0 to skip.
INSTALL_AGENTS="${RUNYARD_INSTALL_AGENTS:-0}"
CODEX_PKG="@openai/codex@${RUNYARD_CODEX_VERSION:-0.142.2}"
CLAUDE_PKG="@anthropic-ai/claude-code@${RUNYARD_CLAUDE_VERSION:-2.1.195}"
PI_PKG="@earendil-works/pi-coding-agent@${RUNYARD_PI_VERSION:-0.80.3}"
SMITHERS_PKG="smithers-orchestrator@${RUNYARD_SMITHERS_VERSION:-0.30.0}"

log()  { printf '\033[1;36m[runyard-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[runyard-install] WARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[runyard-install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Privilege: we write to /opt, /etc and manage systemd. Use sudo when not root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "must run as root or have sudo (writes to $HOME_DIR, $ENV_DIR, systemd)."
  fi
fi
asroot() { if [ -n "$SUDO" ]; then $SUDO "$@"; else "$@"; fi; }

# The unix account the services run as. Default to the invoking (sudo) user, or
# root if invoked directly as root. Operators can override with RUNYARD_SERVICE_USER.
SERVICE_USER="${RUNYARD_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"

DEFAULT_BASE_URL="http://$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo 127.0.0.1):${PORT}"
BASE_URL="${RUNYARD_BASE_URL:-$DEFAULT_BASE_URL}"

# ── 1. Preflight: git, curl, node 22, pnpm ──────────────────────────────────
ensure_prereqs() {
  command -v git >/dev/null 2>&1 || die "git is required."
  command -v curl >/dev/null 2>&1 || die "curl is required."

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ "$node_major" -lt 22 ]; then
    log "Node 22+ not found (have: ${node_major:-none}); attempting install…"
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | asroot bash -
      asroot apt-get install -y nodejs
    else
      die "could not auto-install Node 22 (no apt-get). Install Node 22+ then re-run: https://nodejs.org"
    fi
  fi
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$node_major" -ge 22 ] || die "Node 22+ is required after install (have $node_major)."
  log "node $(node -v) ready."

  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm not found; enabling via corepack…"
    if command -v corepack >/dev/null 2>&1; then
      asroot corepack enable || true
      corepack prepare pnpm@latest --activate 2>/dev/null || asroot npm install -g pnpm
    else
      asroot npm install -g pnpm
    fi
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required and could not be installed."
  log "pnpm $(pnpm -v) ready."
}

# ── 2. Clone (or reuse) the repo at the latest release tag ───────────────────
clone_repo() {
  asroot mkdir -p "$HOME_DIR"
  asroot chown -R "$SERVICE_USER" "$HOME_DIR" 2>/dev/null || true
  if [ -d "$HOME_DIR/.git" ]; then
    log "existing checkout at $HOME_DIR — fetching tags (leaving the working copy as-is; use 'runyard update' to upgrade)."
    git -C "$HOME_DIR" fetch --tags --prune --quiet || warn "git fetch failed; continuing with current checkout."
  else
    log "cloning $REPO_URL -> $HOME_DIR …"
    git clone --quiet "$REPO_URL" "$HOME_DIR" || die "git clone failed."
    local latest
    latest="$(git -C "$HOME_DIR" tag -l 'v*' --sort=-v:refname | head -n1 || true)"
    if [ -n "$latest" ]; then
      log "checking out latest release tag: $latest"
      git -C "$HOME_DIR" checkout -q "tags/$latest" || warn "could not checkout $latest; staying on default branch."
    else
      warn "no v* release tags found; staying on the default branch."
    fi
  fi
}

# ── 3. Install dependencies ──────────────────────────────────────────────────
install_deps() {
  log "installing dependencies (pnpm install --frozen-lockfile)…"
  ( cd "$HOME_DIR" && pnpm install --frozen-lockfile ) || die "pnpm install failed."
}

# ── 3b. Agent CLIs (runner-only, OPT-IN): codex / claude / smithers ──────────
# The runner shells out to these. OFF by default (RUNYARD_INSTALL_AGENTS=1 to
# opt in): the container image bakes them in, the UI manages agents/auth, and a
# forced global install here can stall an unattended `curl | bash` headless
# install. When opted in: pinned for a known-good toolchain, non-fatal (the hub
# runs without them; a runner can be fixed by hand), still needs a per-user login.
install_agent_clis() {
  [ "$INSTALL_RUNNER" = "1" ] || return 0
  if [ "$INSTALL_AGENTS" != "1" ]; then
    log "skipping agent CLI install (RUNYARD_INSTALL_AGENTS=$INSTALL_AGENTS)."
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found — cannot install agent CLIs. Install manually: npm i -g $CODEX_PKG $CLAUDE_PKG $PI_PKG $SMITHERS_PKG"
    return 0
  fi
  log "installing runner agent CLIs (pinned): codex, claude, pi, smithers…"
  asroot npm install -g "$CODEX_PKG" "$CLAUDE_PKG" "$PI_PKG" "$SMITHERS_PKG" \
    || warn "agent CLI install failed — install manually: npm i -g $CODEX_PKG $CLAUDE_PKG $PI_PKG $SMITHERS_PKG"
  for b in codex claude pi smithers; do
    if command -v "$b" >/dev/null 2>&1; then
      log "  ✓ $b -> $(command -v "$b")"
    else
      warn "  ✗ $b not on PATH after install — check your npm global bin is on the runner user's PATH."
    fi
  done
  log "agent CLIs ready. One-time login still required per runner user: 'codex login' and 'claude setup-token'."
}

# ── 4. Data dir (DB + secrets; never touched by updates) ─────────────────────
ensure_data_dir() {
  asroot mkdir -p "$DATA_DIR"
  asroot chown -R "$SERVICE_USER" "$DATA_DIR" 2>/dev/null || true
  log "data dir ready at $DATA_DIR (survives every update + rollback)."
}

# ── 5. Env file + SECRETS_ENC_KEY (idempotent — never clobbered) ─────────────
gen_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'
  fi
}

write_env_files() {
  asroot mkdir -p "$ENV_DIR"
  local hub_env="$ENV_DIR/runyard.env"
  if [ -f "$hub_env" ]; then
    log "keeping existing $hub_env (not clobbering secrets/config)."
  else
    log "writing starter env -> $hub_env (SECRETS_ENC_KEY generated; not printed)."
    local enc_key session_secret
    enc_key="$(gen_key)"
    session_secret="$(gen_key)"
    # umask so the file is created 0600 even before chmod.
    ( umask 077; asroot tee "$hub_env" >/dev/null <<EOF
# RunYard hub config — generated by install.sh. Edit and 'systemctl restart runyard'.
BASE_URL=$BASE_URL
HOST=127.0.0.1
PORT=$PORT
RUNYARD_HUB_INSTANCE_NAME=Runyard
RUNYARD_HUB_DATA_DIR=$DATA_DIR
RUNYARD_HUB_SESSION_SECRET=$session_secret
# Encrypted reusable-secrets store key (32 bytes). Keep this safe; rotating it
# makes existing stored secrets unreadable.
SECRETS_ENC_KEY=$enc_key
# Passive update check (outbound-only GitHub Releases read; never auto-applies).
UPDATE_CHECK_ENABLED=$UPDATE_CHECK_ENABLED
GITHUB_REPO=$GITHUB_REPO
# HTTP-triggered apply is OFF by default; run 'runyard update' on the host instead.
UPDATE_APPLY_ENABLED=0
# Optional: your own Slack/Discord/etc. webhook for update outcomes (no maintainer phone-home).
UPDATE_NOTIFY_WEBHOOK=
REAUTH_ENABLED=$REAUTH_ENABLED_VAL
EOF
    )
    asroot chmod 600 "$hub_env"
    asroot chown "$SERVICE_USER" "$hub_env" 2>/dev/null || true
  fi

  if [ "$INSTALL_RUNNER" = "1" ]; then
    local runner_env="$ENV_DIR/runner.env"
    if [ -f "$runner_env" ]; then
      log "keeping existing $runner_env."
    else
      log "writing starter runner env -> $runner_env."
      # The runner authenticates with a Hub access token. We can't mint one before
      # first boot, so leave a placeholder the operator fills from the Hub UI
      # (Admin -> Tokens / Connect), then 'systemctl restart runyard-runner'.
      ( umask 077; asroot tee "$runner_env" >/dev/null <<EOF
# RunYard runner config — generated by install.sh.
RUNYARD_HUB_URL=http://127.0.0.1:$PORT
# Paste a runner-scoped token from the Hub (Admin -> Tokens), then restart this unit.
RUNYARD_HUB_TOKEN=
# Same data dir as the hub so the drain flag is shared (enables 'runyard update' draining).
RUNYARD_HUB_DATA_DIR=$DATA_DIR
SMITHERS_WORKSPACE=$HOME_DIR
SMITHERS_RUNNER_LOCATION=vps
SMITHERS_RUNNER_CONCURRENCY=1
REAUTH_ENABLED=$REAUTH_ENABLED_VAL
EOF
      )
      asroot chmod 600 "$runner_env"
      asroot chown "$SERVICE_USER" "$runner_env" 2>/dev/null || true
    fi
  fi
}

# ── 6. systemd units (reuse deploy/*.service, retargeted to this install) ─────
install_units() {
  local node_bin
  node_bin="$(command -v node)"
  local hub_src="$HOME_DIR/deploy/runyard.service"
  [ -f "$hub_src" ] || die "missing $hub_src in the checkout."

  log "installing systemd unit: runyard.service"
  sed -e "s#/opt/runyard#$HOME_DIR#g" \
      -e "s#/etc/runyard/runyard.env#$ENV_DIR/runyard.env#g" \
      -e "s#/usr/bin/env node#$node_bin#g" \
      "$hub_src" \
    | sed -e "/^\[Service\]/a User=$SERVICE_USER" \
    | asroot tee /etc/systemd/system/runyard.service >/dev/null

  if [ "$INSTALL_RUNNER" = "1" ]; then
    local runner_src="$HOME_DIR/deploy/runyard-runner.service"
    [ -f "$runner_src" ] || die "missing $runner_src in the checkout."
    log "installing systemd unit: runyard-runner.service"
    # Retarget paths, point the runner at the local hub, and drop the example
    # name so runner.env governs. The hardcoded example URL/name are replaced.
    sed -e "s#/opt/runyard#$HOME_DIR#g" \
        -e "s#/etc/runyard/runner.env#$ENV_DIR/runner.env#g" \
        -e "s#/usr/bin/env node#$node_bin#g" \
        -e "s#https://hub.example.com#http://127.0.0.1:$PORT#g" \
        -e "s#vps-runner-1#$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo runner)#g" \
        "$runner_src" \
      | sed -e "/^\[Service\]/a User=$SERVICE_USER" \
      | asroot tee /etc/systemd/system/runyard-runner.service >/dev/null
  fi

  asroot systemctl daemon-reload
  asroot systemctl enable --now runyard.service || warn "could not enable/start runyard.service"
  if [ "$INSTALL_RUNNER" = "1" ]; then
    # The runner needs a token before it can claim; enable it but it will idle
    # (and log an auth error) until the operator fills RUNYARD_HUB_TOKEN.
    asroot systemctl enable runyard-runner.service || warn "could not enable runyard-runner.service"
  fi
}

# ── 7. Passive update-CHECK timer (NEVER auto-applies) ───────────────────────
install_update_check_timer() {
  local node_bin
  node_bin="$(command -v node)"
  log "installing daily passive update-check timer (check only — never applies)."
  asroot tee /etc/systemd/system/runyard-update-check.service >/dev/null <<EOF
[Unit]
Description=RunYard passive update check (outbound-only; never applies)
After=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$HOME_DIR
EnvironmentFile=$ENV_DIR/runyard.env
ExecStart=$node_bin --experimental-sqlite $HOME_DIR/src/updatectl.js check
EOF
  asroot tee /etc/systemd/system/runyard-update-check.timer >/dev/null <<EOF
[Unit]
Description=Run the RunYard passive update check daily

[Timer]
OnBootSec=10min
OnUnitActiveSec=1d
Persistent=true

[Install]
WantedBy=timers.target
EOF
  asroot systemctl daemon-reload
  asroot systemctl enable --now runyard-update-check.timer || warn "could not enable update-check timer"
}

# ── 8. Final guidance: Caddy snippet + next steps ────────────────────────────
print_next_steps() {
  local host
  host="$(printf '%s' "$BASE_URL" | sed -e 's#^https\?://##' -e 's#[:/].*$##')"
  cat <<EOF

──────────────────────────────────────────────────────────────────────────────
 RunYard installed.

 Hub:        systemctl status runyard
 Runner:     systemctl status runyard-runner   (idles until you set a token)
 Health:     curl -fsS http://127.0.0.1:$PORT/healthz
 Version:    curl -fsS http://127.0.0.1:$PORT/version
 Bootstrap:  $DATA_DIR/bootstrap-token.txt   (first admin token; chmod 600)

 Next:
   1. Open the Hub, sign in with the bootstrap token, mint a runner-scoped token.
   2. Put it in $ENV_DIR/runner.env (RUNYARD_HUB_TOKEN=...), then:
        systemctl restart runyard-runner
   3. Agent CLIs (codex/claude): manage + authenticate them from the Hub UI
      (runner card -> Re-auth). The container image ships them; on a bare-host
      runner that needs them, re-run with RUNYARD_INSTALL_AGENTS=1 (or install
      them yourself) and they'll show up for the UI to authenticate.
   4. Updates: an admin sees an "update available" badge in the UI.
      Apply on the host with:   runyard update
      (drains runners, swaps, restarts, verifies, auto-rolls-back on failure.)

 Reverse proxy (TLS) — Caddy is NOT installed/assumed. If you use Caddy, add to
 your Caddyfile (then 'caddy reload'):

   $host {
       reverse_proxy 127.0.0.1:$PORT
   }

 Then set BASE_URL=https://$host in $ENV_DIR/runyard.env and restart runyard.
──────────────────────────────────────────────────────────────────────────────
EOF
}

main() {
  log "installing RunYard into $HOME_DIR (env: $ENV_DIR, data: $DATA_DIR, user: $SERVICE_USER)"
  ensure_prereqs
  clone_repo
  install_deps
  install_agent_clis
  ensure_data_dir
  write_env_files
  install_units
  install_update_check_timer
  print_next_steps
  log "done."
}

main "$@"
