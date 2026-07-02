#!/usr/bin/env bash
# Install the RunYard bwrap AppArmor profile so RUNNER_SANDBOX=bubblewrap can
# create unprivileged user namespaces WITHOUT disabling the box-wide restriction
# (kernel.apparmor_restrict_unprivileged_userns). The profile grants the `userns`
# capability to /usr/bin/bwrap only; every other program stays restricted.
#
# Idempotent. Requires root. Does NOT change any sysctl and does NOT restart any
# service — it only loads one AppArmor profile.
#
#   sudo deploy/apparmor/install.sh            # install + load + verify
#   sudo deploy/apparmor/install.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE_SRC="$HERE/bwrap"
DEST=/etc/apparmor.d/bwrap
BWRAP=/usr/bin/bwrap

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo $0 $*)"
command -v apparmor_parser >/dev/null 2>&1 || die "apparmor_parser not found — is AppArmor installed? (apt install apparmor)"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$DEST" ]; then
    apparmor_parser -R "$DEST" 2>/dev/null || true
    rm -f "$DEST"
    echo "removed AppArmor profile: $DEST"
  else
    echo "nothing to remove: $DEST is not installed"
  fi
  exit 0
fi

[ -f "$PROFILE_SRC" ] || die "profile source missing: $PROFILE_SRC"
[ -x "$BWRAP" ] || echo "warning: $BWRAP is not present/executable yet — the profile attaches to that path and will take effect once bwrap is installed there" >&2

# Validate before touching the system, then install and (re)load. `-r` replaces
# an existing profile, so re-running is safe.
apparmor_parser -N "$PROFILE_SRC" >/dev/null || die "profile failed to parse: $PROFILE_SRC"
install -m 0644 "$PROFILE_SRC" "$DEST"
apparmor_parser -r -W "$DEST"
echo "loaded AppArmor profile 'bwrap' from $DEST"

# Best-effort proof that an UNPRIVILEGED user can now create a userns via bwrap.
# Runs as the invoking (pre-sudo) user, which is the case that was failing.
if [ -n "${SUDO_USER:-}" ] && [ -x "$BWRAP" ]; then
  if sudo -u "$SUDO_USER" "$BWRAP" --unshare-user --uid 0 --gid 0 \
      --ro-bind /usr /usr --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
      --proc /proc /usr/bin/true 2>/dev/null; then
    echo "verified: unprivileged user namespaces now work for bwrap"
  else
    echo "warning: bwrap still cannot create a user namespace for $SUDO_USER." >&2
    echo "         Check 'sysctl kernel.apparmor_restrict_unprivileged_userns' and 'aa-status | grep bwrap'." >&2
    exit 1
  fi
fi

echo "Done. RUNNER_SANDBOX=bubblewrap no longer needs the box-wide sysctl override."
