#!/usr/bin/env bash
#
# runyard-update.sh — operator-initiated, self-healing APPLY for a self-hosted
# RunYard box. This is the APPLY half of CHECK != APPLY: it is never run
# automatically; an operator runs `runyard update` (which calls this) or the
# admin UI triggers it. It drains in-flight runner work, swaps to the target
# release, restarts, verifies health, and AUTO-ROLLS-BACK on failure.
#
# Usage:  runyard-update.sh [vX.Y.Z]
#   no arg  -> update to the highest local v* tag (after `git fetch --tags`)
#   vX.Y.Z  -> update to that explicit tag
#
# ── Re-exec safety ──────────────────────────────────────────────────────────
# This script mutates its own working tree (git checkout) while running. Bash
# reads a script by byte offset as it executes, so if the working-tree copy of
# THIS file changes mid-run, execution can jump into garbage. To stay safe we
# copy ourselves to a temp file and re-exec from there BEFORE touching the tree;
# the /tmp copy is immutable for the run and removed on exit. Everything after
# the re-exec guard runs from /tmp and is unaffected by the checkout.
#
# ── Rollback robustness ─────────────────────────────────────────────────────
# Rollback uses the current tag/commit captured into shell variables at the very
# start — not a file or a node call — so even a completely broken new release
# (one whose node won't even start) can still be rolled back by bash + git +
# curl alone. Outcome alerts are written only AFTER we are back on known-good
# code, so the alert is recorded by code we trust.
set -euo pipefail

# ── Re-exec from a private temp copy ─────────────────────────────────────────
if [ -z "${RUNYARD_UPDATE_REEXEC:-}" ]; then
  src_self="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)/$(basename "$0")"
  RUNYARD_REPO_DIR="${RUNYARD_REPO_DIR:-$(cd "$(dirname "$src_self")/.." >/dev/null 2>&1 && pwd)}"
  tmp_self="$(mktemp "${TMPDIR:-/tmp}/runyard-update.XXXXXX.sh")"
  cp "$src_self" "$tmp_self"
  chmod +x "$tmp_self"
  export RUNYARD_UPDATE_REEXEC=1
  export RUNYARD_REPO_DIR
  exec bash "$tmp_self" "$@"
fi
# Running from the /tmp copy now; remove it when we exit.
trap 'rm -f "$0"' EXIT

REPO="${RUNYARD_REPO_DIR:?repo dir was not resolved}"
NODE_BIN="${RUNYARD_NODE:-node}"
HELPER="$REPO/src/updatectl.js"
PORT="${PORT:-43117}"
HEALTH_URL="${RUNYARD_HEALTH_URL:-http://127.0.0.1:${PORT}/healthz}"
HEALTH_TIMEOUT="${RUNYARD_HEALTH_TIMEOUT_SECONDS:-30}"
DRAIN_GRACE_MS="${RUNYARD_DRAIN_GRACE_MS:-2700000}"
# Space-separated systemd units to restart. Empty disables restart (dev/staging
# without systemd) — the swap is staged but not made live, and health is skipped.
UNITS="${RUNYARD_UNITS:-runyard runyard-runner}"

log() { printf '[runyard-update] %s\n' "$*"; }
die() { log "ERROR: $*"; exit 1; }

# DB/logic helper (drain, last-good marker, alerts). Needs --experimental-sqlite
# because it imports the node:sqlite-backed db layer.
helper() { "$NODE_BIN" --experimental-sqlite "$HELPER" "$@"; }

sudo_if_needed() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

hash_file() {
  if [ -f "$1" ]; then sha256sum "$1" 2>/dev/null | awk '{print $1}'; else echo "absent"; fi
}

restart_units() {
  if [ -z "${UNITS// /}" ]; then
    log "RUNYARD_UNITS empty — skipping restart (swap is staged, not live)."
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    log "systemctl not found — cannot restart units ($UNITS)."
    return 1
  fi
  # Word-splitting on UNITS is intentional (multiple unit names).
  # shellcheck disable=SC2086
  sudo_if_needed systemctl restart $UNITS
}

# Poll /healthz until it returns success or the window expires. Pure curl so it
# is independent of node — a broken release can't fake health.
check_health() {
  if ! command -v curl >/dev/null 2>&1; then
    log "curl not found — cannot verify health; skipping the health gate."
    return 0
  fi
  local deadline
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# AUTO-ROLLBACK to the known-good tag/commit captured at start. Uses only bash +
# git + curl so it works even if the target release is unrunnable.
rollback() {
  local why="$1"
  log "AUTO-ROLLBACK: $why"
  local good_ref="" good_label=""
  if [ -n "$CURRENT_TAG" ]; then
    good_ref="tags/$CURRENT_TAG"; good_label="$CURRENT_TAG"
  elif [ -n "$CURRENT_COMMIT" ]; then
    good_ref="$CURRENT_COMMIT"; good_label="$CURRENT_COMMIT"
  fi
  if [ -z "$good_ref" ]; then
    helper alert --status failed --to "$TARGET_TAG" \
      --message "Update to $TARGET_TAG failed ($why) and no known-good ref was available to roll back to. Manual intervention required." || true
    die "no known-good ref to roll back to: $why"
  fi
  log "restoring $good_label …"
  git checkout -q "$good_ref" || log "warning: rollback checkout reported an error"
  # Reinstall deps if the restored tree's lockfile differs from the broken target.
  local rb_lock
  rb_lock="$(hash_file pnpm-lock.yaml)"
  if [ "$rb_lock" != "$NEW_LOCK_HASH" ] && command -v pnpm >/dev/null 2>&1; then
    log "lockfile differs after rollback — reinstalling deps…"
    pnpm install --frozen-lockfile || log "warning: pnpm install during rollback failed"
  fi
  restart_units || log "warning: restart during rollback failed"
  helper clear-drain || true
  if check_health; then
    helper alert --status failed --from "$TARGET_TAG" --to "$good_label" \
      --message "Update to $TARGET_TAG failed ($why); rolled back to $good_label and the hub is healthy again." || true
    log "rolled back to $good_label; hub healthy."
    exit 2
  fi
  helper alert --status failed --from "$TARGET_TAG" --to "$good_label" \
    --message "Update to $TARGET_TAG failed ($why); rollback to $good_label did NOT pass the health check. Manual intervention required." || true
  die "rollback health check failed after restoring $good_label; manual intervention required"
}

# ── Main ─────────────────────────────────────────────────────────────────────
cd "$REPO"
command -v git >/dev/null 2>&1 || die "git is required"
[ -f "$HELPER" ] || die "helper not found at $HELPER"

CURRENT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "")"
CURRENT_TAG="$(git describe --tags --exact-match 2>/dev/null || echo "")"
# Initialized early so rollback() can reference it safely under `set -u` even on
# paths that abort before the post-checkout lockfile snapshot is taken.
NEW_LOCK_HASH=""

log "fetching tags…"
git fetch --tags --prune --quiet || die "git fetch failed"

TARGET_TAG="${1:-}"
if [ -z "$TARGET_TAG" ]; then
  TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
fi
[ -n "$TARGET_TAG" ] || die "no target tag found (no v* tags). Pass one explicitly: runyard-update.sh vX.Y.Z"
git rev-parse -q --verify "refs/tags/${TARGET_TAG}^{commit}" >/dev/null 2>&1 \
  || die "tag $TARGET_TAG not found after fetch"

if [ -n "$CURRENT_TAG" ] && [ "$TARGET_TAG" = "$CURRENT_TAG" ]; then
  log "already on $TARGET_TAG — nothing to do."
  exit 0
fi
log "current: ${CURRENT_TAG:-${CURRENT_COMMIT:-unknown}}  ->  target: $TARGET_TAG"

# 2. Record last-known-good BEFORE any change (persisted under dataDir for the UI;
#    in-run rollback uses the shell vars above, which are immune to a broken release).
helper record-last-good --tag "$CURRENT_TAG" --commit "$CURRENT_COMMIT" >/dev/null \
  || log "warning: could not persist last-good marker (continuing; in-run rollback still works)"

# 3. Drain runners — bounded; abort (no changes) if in-flight work won't finish.
#    Hub vs runner asymmetry: runners MUST drain (a mid-run restart destroys the
#    agent's non-durable work). The hub itself is DB-durable and resumes after a
#    bounce, so once runners have drained, running==0 and restarting the hub is
#    safe. We do not kill in-flight work; we wait, then abort if it overruns.
log "draining runners (grace ${DRAIN_GRACE_MS}ms; will abort, not kill, if it overruns)…"
if ! helper drain --grace-ms "$DRAIN_GRACE_MS" --target "$TARGET_TAG" --by "runyard-update"; then
  helper alert --status failed --from "${CURRENT_TAG:-$CURRENT_COMMIT}" --to "$TARGET_TAG" \
    --message "Update aborted: runners did not drain within the grace window. No code was changed." || true
  die "drain timed out; update aborted (no changes made)"
fi

OLD_LOCK_HASH="$(hash_file pnpm-lock.yaml)"

# 4. Checkout the target tag.
log "checking out $TARGET_TAG…"
if ! git checkout -q "tags/$TARGET_TAG"; then
  helper clear-drain || true
  helper alert --status failed --from "${CURRENT_TAG:-$CURRENT_COMMIT}" --to "$TARGET_TAG" \
    --message "Update aborted: checkout of $TARGET_TAG failed. Cleared drain; no restart performed." || true
  die "checkout of $TARGET_TAG failed (drain cleared, nothing restarted)"
fi
NEW_LOCK_HASH="$(hash_file pnpm-lock.yaml)"

# 5. Install dependencies only if the lockfile actually changed.
if [ "$OLD_LOCK_HASH" != "$NEW_LOCK_HASH" ]; then
  command -v pnpm >/dev/null 2>&1 || rollback "pnpm not found but lockfile changed"
  log "lockfile changed — running pnpm install --frozen-lockfile…"
  pnpm install --frozen-lockfile || rollback "pnpm install failed on $TARGET_TAG"
else
  log "lockfile unchanged — skipping dependency install."
fi

# 6. Restart units, clear drain, then verify health.
log "restarting units: ${UNITS:-<none>}"
restart_units || rollback "restart failed on $TARGET_TAG"
helper clear-drain || log "warning: could not clear drain flag via new code (rollback would clear it)"
log "verifying health at $HEALTH_URL (≤${HEALTH_TIMEOUT}s)…"
check_health || rollback "healthcheck failed on $TARGET_TAG"

# 7. Success.
helper alert --status success --from "${CURRENT_TAG:-$CURRENT_COMMIT}" --to "$TARGET_TAG" \
  --message "Update applied and healthy on $TARGET_TAG." || true
log "update complete — now on $TARGET_TAG and healthy."
exit 0
