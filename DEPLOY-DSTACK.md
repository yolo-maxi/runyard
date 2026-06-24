# Deploying RunYard on dstack (Intel TDX confidential VMs)

This guide covers running RunYard (the **hub** control plane + a **runner**) as a
dstack app inside an Intel TDX confidential VM (CVM). It assumes you have a dstack
deployment target and the operator tooling to create apps and run `UpgradeApp`.

> Each RunYard deployment is its **own CVM** — not a shared cluster. dstack runs
> your `docker-compose.yml` with a full Docker daemon **inside the CVM guest**.
> The CVM boundary is the hardware-attested tenant isolation boundary. You own the
> guest (kernel, dockerd, KMS-encrypted disk); you have no access to the bare-metal
> host.

## Components

| Service | Image | Listens / does | Storage |
| ------- | ----- | -------------- | ------- |
| `hub`    | `ghcr.io/yolo-maxi/runyard-hub`    | HTTP on **:80** (control plane + web UI + embedded datastore) | named volume `hub-data` → `/data` |
| `runner` | `ghcr.io/yolo-maxi/runyard-runner` | claims runs, executes `smithers up …`, can `docker build` against guest dockerd | scratch volume `runner-workspace` → `/workspace` |

Files:
- `Dockerfile.hub`, `Dockerfile.runner` — image builds.
- `docker-compose.yml` — the dstack app-compose (digest-pinned, no Caddy/TLS).
- `.github/workflows/images.yml` — builds + pushes both images to GHCR on `v*` tags and emits digests.

---

## 1. Build & push images (CI)

Images are built and pushed by GitHub Actions, **not** by hand on the box.

1. Ensure the test gate is green, then push a release tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
2. `.github/workflows/images.yml`:
   - re-runs `pnpm test` (gate — a red run never publishes),
   - builds `Dockerfile.hub` → `ghcr.io/yolo-maxi/runyard-hub`,
   - builds `Dockerfile.runner` → `ghcr.io/yolo-maxi/runyard-runner`,
   - pushes both to GHCR (public),
   - **emits the resulting `@sha256:` digests** to the job summary and to a
     release/run artifact named `dstack-image-digests`.

Both GHCR packages must be **public** (Package settings → Change visibility →
Public) so the CVM can pull without credentials. (Private images would instead
use dstack encrypted env for the registry creds — not needed here.)

### Building locally (optional, for testing only)

```bash
docker build -f Dockerfile.hub    -t runyard-hub:local .
docker build -f Dockerfile.runner -t runyard-runner:local .
```

Build ARGs you can override (all pinned by default):
`SMITHERS_VERSION=0.25.1`, `BUN_VERSION=1.3.14`, `DOCKER_CLI_VERSION=29.6.0`,
`NODE_VERSION=22`, `PNPM_VERSION=10.33.0`.

---

## 2. Where digests come from / fill the compose

dstack attestation measures the **compose text**. A mutable tag (`:latest`, `:v0.1.0`)
commits to the *string*, not the *bytes*, so it would not bind your code to the
attestation. **Every image MUST be pinned by `@sha256:` digest.**

Digests only exist *after* the first CI push, so `docker-compose.yml` ships with
placeholders:

```yaml
  hub:
    image: ghcr.io/yolo-maxi/runyard-hub@sha256:REPLACE_WITH_HUB_DIGEST
  runner:
    image: ghcr.io/yolo-maxi/runyard-runner@sha256:REPLACE_WITH_RUNNER_DIGEST
```

After the CI run, grab the digests from the job summary / the
`dstack-image-digests` artifact (or `docker buildx imagetools inspect <image>:<tag>`)
and paste them in:

```yaml
  hub:
    image: ghcr.io/yolo-maxi/runyard-hub@sha256:0123…  # 64 hex chars
  runner:
    image: ghcr.io/yolo-maxi/runyard-runner@sha256:89ab…
```

No `:latest`, no Watchtower, no `docker compose pull`. The digest *is* the version.

---

## 3. Ingress, TLS, and the :80 contract

dstack-gateway terminates TLS and reverse-proxies to your container on
**port 80 by default**:

```
https://<app_id>.gateway.attestmesh.xyz/  →  hub container :80
```

So the hub **must listen on :80**, and we ship **no Caddy and no own-TLS**. The
hub image defaults to `HOST=0.0.0.0 PORT=80` (read by `src/env.js`); the
unprivileged `node` user binds :80 via a `cap_net_bind_service` capability set on
the node binary at build time.

Set `BASE_URL` to your gateway hostname so HTTPS links and production-mode session
handling are correct:

```yaml
    environment:
      BASE_URL: "https://<app_id>.gateway.attestmesh.xyz"
```

---

## 4. Secrets (dstack encrypted env)

`docker-compose.yml` references secrets via `${VAR}` but **never inlines them**.
Provide them through dstack's **encrypted env** for the app:

| Var | Service | Purpose |
| --- | ------- | ------- |
| `SMITHERS_HUB_SESSION_SECRET` | hub | long random session secret (required in prod / https) |
| `SMITHERS_HUB_BOOTSTRAP_TOKEN` | hub | bootstrap admin/runner token |
| `SECRETS_ENC_KEY` | hub | 32-byte base64/hex key for the reusable-secrets store (`openssl rand -base64 32`) |
| `SMITHERS_HUB_TOKEN` | runner | runner auth token (matches a hub-issued runner token) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | runner | agent API keys |

> **Agent CLIs are not baked into the runner image.** `claude` / `codex` must be
> provided and authenticated at runtime (mounted credentials or encrypted env).
> Don't bake secrets into images — the image is attested and public.

---

## 5. Storage & disk sizing

- **Persistence = a KMS-encrypted, per-CVM disk.** Named volumes / bind mounts
  survive container recreation and CVM reboot, but **NOT app destruction**
  (`RemoveVm` wipes the disk and its KMS keys).
- **Disk size is fixed at create time** — no elastic growth. Size deliberately.
- The **hub datastore** (`hub-data` → `/data`: SQLite + artifacts) is small and
  long-lived — keep it on the named volume.
- The **runner workspace** (`runner-workspace` → `/workspace`) is large scratch:
  repo clones, build trees, agent output. Persist only what matters back to the
  hub (the runner already uploads outputs + event traces as hub artifacts). Size
  the CVM disk for the biggest repo/build you expect, plus headroom.

Suggested starting point: hub data a few GB; runner workspace 20–50 GB depending
on repo sizes. Adjust at CVM create; you cannot grow it later.

---

## 6. Updates & rollback — dstack UpgradeApp (NOT compose pull)

On dstack, **APPLY = `UpgradeApp`**, full stop. RunYard's host-side self-update
*apply* path (`runyard update` git-checkout/rollback) is **not used** here and is
disabled in the compose (`UPDATE_APPLY_ENABLED=0`). The in-app update **CHECK**
(version/digest awareness in the admin UI) stays on as **informational only** — it
tells you an update exists; it does not apply it.

To update:
1. CI builds new images on a new tag → new digests.
2. Edit `docker-compose.yml`, swap in the **new digests**.
3. Run **`UpgradeApp`** with the new compose, keeping the **same `app_id`, KMS
   keys, and disk**. The new compose-hash is re-measured/attested.

To roll back:
- **`UpgradeApp` back to the previous compose** (the previous digests). Same
  `app_id`/keys/disk. There is no separate rollback mechanism — rollback is just
  an upgrade to the older measured compose.

**No Watchtower. No `docker compose pull`. No auto-pull.** A digest pin plus
UpgradeApp is the entire update story.

---

## 7. Hub ↔ runner communications

The hub and runner can run **in the same CVM/compose** (as shipped) or as
**separate CVMs**:

- **Same compose (default):** the runner reaches the hub via the compose service
  name — `SMITHERS_HUB_URL=http://hub:80`.
- **Separate CVMs:** point the runner at the hub's **gateway URL**
  (`https://<hub_app_id>.gateway.attestmesh.xyz`) or a direct reachable address,
  and give it a valid `SMITHERS_HUB_TOKEN`. The token is the trust boundary; the
  runner registers and heartbeats over HTTPS.

The runner logs its identity + resolved engine on start, e.g.
`Registered Smithers runner … smithers=/usr/local/bun/bin/smithers`.

---

## 8. Resource limits & boot behavior

- Resource ceilings are set at **CVM create**; cold boot is the real limiter
  (~40 s serialized cold starts, ~90 boots/host/hr).
- **Do NOT spin a CVM per run.** Use a **long-lived runner CVM** and execute each
  run as work inside it (optionally driving `docker build` against the guest
  dockerd). Bound individual builds with compose `cpus` / `mem_limit` (set in
  `docker-compose.yml`) — these cap usage *within* the CVM; the hard ceiling is
  the CVM's create-time sizing.

---

## 9. Guest Docker access for the runner

Inside the CVM you own dockerd, so the runner may build containers per run. Two
options (the compose ships Option A active, Option B commented):

- **Option A — guest socket mount** (default): mount the guest CVM docker socket
  `/var/run/docker.sock` into the runner and set `DOCKER_HOST=unix:///var/run/docker.sock`.
  This is the **guest** socket (you own it), never the bare-metal host socket.
- **Option B — rootless DinD sidecar:** run a `docker:dind-rootless` service and
  point the runner's `DOCKER_HOST` at it. Use this if the dstack app-compose
  parser restricts socket mounts (see "verify on target").

---

## ⚠️ Verify on target

These assumptions could not be verified outside a real dstack CVM. Confirm each on
the actual target before relying on it:

1. **app-compose parser policy (#9 / #1):** dstack's app-compose parser may
   restrict `privileged:` and/or host-socket mounts (`/var/run/docker.sock`). If
   the socket mount is rejected, switch the runner to the rootless DinD sidecar
   (Option B). Confirm which the parser allows.
2. **On-chain compose-hash authorization for UpgradeApp (#6):** on-chain KMS may
   require the new compose-hash to be **authorized in the app registry before** an
   upgraded CVM can unseal its disk — i.e. an extra on-chain transaction per
   rollout (and per rollback, since rollback is also an upgrade). Confirm the
   exact authorization flow for your KMS.
3. **Default disk size (#5):** confirm the create-time disk size and that it
   comfortably holds the hub datastore + the largest runner workspace you expect.
   It cannot be grown after create.
4. **Gateway → :80 default:** confirm dstack-gateway proxies to container port 80
   for your app (the hub is built to listen there); adjust `PORT`/exposed port if
   your gateway maps a different container port.
5. **GHCR pull from inside the CVM:** confirm the public GHCR packages pull from
   the CVM's network egress without credentials.
