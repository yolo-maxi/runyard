# Deploying RunYard (containers)

RunYard ships two environment-agnostic images and a portable compose stack that
runs anywhere — a self-hosted box, a VPS, Kubernetes (via kompose), or as the
base for a confidential-VM deployment. Platform specifics live in **overlays**,
not in the base.

| Image | Role | Listens / does | Storage |
| ----- | ---- | -------------- | ------- |
| `ghcr.io/yolo-maxi/runyard-hub`    | control plane + web UI + embedded datastore | HTTP on `PORT` (default **8080**) | volume `hub-data` → `/data` |
| `ghcr.io/yolo-maxi/runyard-runner` | claims runs, executes `smithers up …`, optional `docker build` | — | volume `runner-workspace` → `/workspace` |

Files:
- `Dockerfile.hub`, `Dockerfile.runner` — image builds (env-agnostic).
- `docker-compose.yml` — portable base (env-driven, tag-based, optional proxy).
- `docker-compose.local.yml` — dev profile (locally-built images).
- `deploy/compose/Caddyfile` — config for the optional TLS `proxy` profile.
- `deploy/compose/runner-docker-socket.yml` — optional runner docker-build toggle.
- `deploy/dstack/` — the dstack (Intel TDX confidential VM) overlay + README.
- `.github/workflows/images.yml` — CI: builds/pushes both images on `v*` tags,
  emits tags **and** `@sha256:` digests.

---

## 1. Build & push images

CI (`.github/workflows/images.yml`) builds and pushes both images to GHCR on a
pushed `v*` tag, after `pnpm test` passes:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

It publishes semver tags (`0.1.0`, `0.1`) and a `sha-<commit>` tag, and emits the
resulting `@sha256:` digests to the job summary and a `dstack-image-digests`
artifact.

Build locally for testing:

```bash
docker build -f Dockerfile.hub    -t runyard-hub:local .
docker build -f Dockerfile.runner -t runyard-runner:local .
```

Pinned build ARGs (override if needed): `SMITHERS_VERSION=0.25.1`,
`BUN_VERSION=1.3.14`, `DOCKER_CLI_VERSION=29.6.0`, `NODE_VERSION=22`,
`PNPM_VERSION=10.33.0`.

---

## 2. Run the portable stack

```bash
# Pick image refs (tag or digest) and a port; provide secrets via a .env file.
HUB_IMAGE=ghcr.io/yolo-maxi/runyard-hub:0.1.0 \
RUNNER_IMAGE=ghcr.io/yolo-maxi/runyard-runner:0.1.0 \
HUB_PORT=8080 \
docker compose up -d
```

Key env vars (all have sensible defaults; see `docker-compose.yml`):

| Var | Service | Meaning |
| --- | ------- | ------- |
| `HUB_IMAGE` / `RUNNER_IMAGE` | both | image refs (tag **or** `@sha256:` digest) |
| `HUB_PORT` | hub | container + published port (default 8080) |
| `BASE_URL` | hub | public URL (https → production session mode) |
| `RUNYARD_HUB_SESSION_SECRET` | hub | long random secret (required in prod/https) |
| `RUNYARD_HUB_BOOTSTRAP_TOKEN` | hub | bootstrap admin/runner token |
| `SECRETS_ENC_KEY` | hub | 32-byte base64/hex for the secrets store |
| `RUNYARD_HUB_URL` | runner | how the runner reaches the hub |
| `RUNYARD_HUB_TOKEN` | runner | runner auth token |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | runner | agent API keys |

> The `RUNYARD_HUB_*` names above are current. The legacy `SMITHERS_HUB_*`
> equivalents are still read as fallbacks, so existing deployments keep working.

> **Agent CLIs (`claude` / `codex`) are not baked into the runner image.** Provide
> and authenticate them at runtime (mounted creds / env). Never bake secrets into
> images.

### Optional: TLS reverse proxy (self-hosters without a gateway)

If nothing in front terminates TLS, enable the bundled Caddy proxy:

```bash
SITE_ADDRESS=hub.example.com docker compose --profile proxy up -d
```

Caddy gets an automatic Let's Encrypt cert for `SITE_ADDRESS` and proxies to the
hub. If you already have an external gateway/load balancer (cloud LB, k8s ingress,
dstack-gateway), **do not** use this profile — let the upstream terminate TLS.

### Optional: runner docker-build access

The runner image includes the docker CLI but no daemon. To let workflows run
`docker build`, give it a daemon:

```bash
# Host/guest socket (you own that daemon):
docker compose -f docker-compose.yml -f deploy/compose/runner-docker-socket.yml up -d
```

Or run a rootless DinD sidecar and set the runner's `DOCKER_HOST` to it — preferred
where socket mounts are disallowed by policy.

### Optional: per-launch sandbox (`RUNNER_SANDBOX=bubblewrap`)

Set `RUNNER_SANDBOX=bubblewrap` to run each workflow launch inside a Bubblewrap
sandbox (filesystem-isolated, writable HOME under the workspace). Requires
`bwrap` on the runner host. On Ubuntu 23.10+ unprivileged user namespaces are
restricted, so install the narrow AppArmor profile once — it grants `userns` to
`/usr/bin/bwrap` only, leaving the box-wide restriction in force for everything
else:

```bash
sudo deploy/apparmor/install.sh          # see deploy/apparmor/README.md
```

Without it (and without the broader `sysctl` fallback) launches fail with
`setting up uid map: Permission denied`; the runner logs this remediation at
startup.

### Local development

```bash
docker build -f Dockerfile.hub -t runyard-hub:local .
docker build -f Dockerfile.runner -t runyard-runner:local .
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
curl localhost:8080/healthz
```

---

## 3. Digest pinning (recommended everywhere)

Mutable tags (`:latest`, `:0.1.0`) can be repointed at different bytes. For
reproducible, tamper-evident deploys, pin images by digest:

```yaml
HUB_IMAGE=ghcr.io/yolo-maxi/runyard-hub@sha256:<64-hex>
RUNNER_IMAGE=ghcr.io/yolo-maxi/runyard-runner@sha256:<64-hex>
```

Digests come from the CI job summary / `dstack-image-digests` artifact, or
`docker buildx imagetools inspect <image>:<tag>`. This is **best practice for
everyone** and **required** on dstack (attestation measures the compose text — see
`deploy/dstack/README.md`).

---

## 4. Updates (APPLY) — per target

RunYard's in-app update **CHECK** (version/digest awareness in the admin UI) is
generic and works everywhere — it tells you an update exists. How you **APPLY** an
update depends on the platform; no single mechanism is baked in:

| Target | APPLY | Rollback |
| ------ | ----- | -------- |
| Plain Docker / compose (tags) | bump the tag → `docker compose pull && docker compose up -d` | repoint to the previous tag/digest |
| Compose (digests) | swap `@sha256:` → `docker compose up -d` | swap back to the previous digest |
| Kubernetes | `kubectl set image` / Helm upgrade (rolling) | `kubectl rollout undo` / Helm rollback |
| Host install | `runyard update` (git checkout) | `runyard update` to the prior ref |
| dstack (Intel TDX) | **`UpgradeApp`** with new digests | `UpgradeApp` back to previous digests |

There is no Watchtower / auto-pull in the shipped stack — updates are deliberate.
For the dstack model in detail, see **`deploy/dstack/README.md`**.

---

## 5. Storage & data

- Hub datastore (SQLite + artifacts) lives on the `hub-data` volume at `/data`.
  Back it up / put it on durable storage; it survives container recreation.
- Runner workspace (`runner-workspace` → `/workspace`) is large scratch: clones,
  build trees, agent output. The runner already uploads outputs + event traces to
  the hub as artifacts, so the workspace itself is disposable. Size it for the
  biggest repo/build you expect.

---

## 6. Hub ↔ runner communications

- **Same compose:** runner → `RUNYARD_HUB_URL=http://hub:${HUB_PORT}`.
- **Separate hosts:** point the runner at the hub's public URL (behind your
  gateway/proxy) with a valid `RUNYARD_HUB_TOKEN`. The token is the trust
  boundary; the runner registers + heartbeats over HTTP(S).

---

## Confidential VMs (dstack / Intel TDX)

See **[`deploy/dstack/README.md`](deploy/dstack/README.md)** for the overlay,
digest-pinning requirement, the `:80`-behind-gateway contract, the UpgradeApp
update/rollback model, disk sizing, and the "verify on target" list.
