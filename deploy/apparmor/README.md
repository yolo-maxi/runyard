# bwrap AppArmor profile (for `RUNNER_SANDBOX=bubblewrap`)

The runner's Bubblewrap sandbox preset launches each workflow inside an
unprivileged user namespace (`bwrap --unshare-user --uid 0 --gid 0 …`). On
Ubuntu 23.10+ (and other kernels built with
`kernel.apparmor_restrict_unprivileged_userns=1`) that is blocked by default —
every launch fails with:

```
bwrap: setting up uid map: Permission denied
```

There are two ways to allow it. **Prefer the profile.**

## Option A — narrow AppArmor profile (recommended)

[`bwrap`](./bwrap) is a `flags=(unconfined)` stub that grants the `userns`
capability to `/usr/bin/bwrap` **only**. The box-wide restriction stays in force
for every other program, so the blast radius is one binary instead of the whole
system.

```bash
sudo deploy/apparmor/install.sh          # install, load, and verify
```

The installer validates the profile, copies it to `/etc/apparmor.d/bwrap`,
reloads it (`apparmor_parser -r`), and — when run via `sudo` — proves an
unprivileged `bwrap` userns now works. It changes no sysctl and restarts no
service. Re-running is safe (idempotent). Remove with:

```bash
sudo deploy/apparmor/install.sh --uninstall
```

## Option B — disable the restriction box-wide (broad; not recommended)

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# persist: echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf
```

This lets **every** program on the host create unprivileged user namespaces —
a much larger attack surface. Use only where Option A is unavailable.

## Verifying

```bash
# as an unprivileged user, with the box-wide restriction still =1:
bwrap --unshare-user --uid 0 --gid 0 --ro-bind /usr /usr \
  --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --proc /proc /usr/bin/true \
  && echo OK
aa-status | grep bwrap        # profile should be listed
```

If bwrap is not installed at `/usr/bin/bwrap`, install it first
(`apt install bubblewrap`); the profile attaches to that path.

## CI coverage

This exact path is exercised on every PR, push to main, and release tag: the
`sandbox-smoke` job (`.github/workflows/release.yml`, mirrored in `images.yml`)
installs bubblewrap on a stock Ubuntu 24.04 runner, runs `install.sh` as an
operator would, and then runs the sandbox test suites with
`RUNYARD_REQUIRE_BWRAP=1` — which turns the real-bwrap userns smoke from
skip-if-unavailable into fail-if-unavailable. A change that breaks the profile,
the installer, or the generated `bwrap` argv turns CI red instead of skipping.
