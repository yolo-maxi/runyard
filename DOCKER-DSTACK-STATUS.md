# Docker / dstack packaging — status

Branch: `feat/docker-dstack`. Packaging/infra only — no app business logic or DB
schema changes. The base is **portable**; dstack is **one overlay**.

## What's built

### Images (environment-agnostic)
- **`Dockerfile.hub`** — multi-stage node 22 + pnpm (corepack, pinned 10.33.0).
  `pnpm install --frozen-lockfile` → `pnpm build:vendor` → `pnpm prune --prod`.
  Runtime: non-root `node` user, `cap_net_bind_service` on the node binary so it
  can bind low ports (e.g. `PORT=80` behind a gateway) without root. Listens on
  `PORT` (**default 8080**, configurable). Datastore on `/data` volume. tini PID 1.
  Final image ~362 MB.
- **`Dockerfile.runner`** — node 22 + pnpm + **bun 1.3.14** + **smithers-orchestrator
  @0.25.1** (`bun add -g`, ARG-pinned) + **git** + **docker static CLI 29.6.0**.
  Workspace on `/workspace` volume. `SMITHERS_BIN` pinned to the bun global path.
  Agent CLIs (claude/codex) intentionally NOT baked in. Final image ~759 MB.
- Pinned, overridable build ARGs: `SMITHERS_VERSION`, `BUN_VERSION`,
  `DOCKER_CLI_VERSION`, `NODE_VERSION`, `PNPM_VERSION`.

### Code (minimal, required edits only)
- **`src/resolveSmithersBin.js`** (new) — `SMITHERS_BIN` env → bun global
  (`$BUN_INSTALL/bin/smithers`) → `smithers` on PATH. Pure/side-effect-free.
- **`src/smithers-runner.js`** — imports the helper, resolves the bin once at
  startup, uses it in the `smithers()` exec wrapper, logs it on register.
- **`tests/resolve-smithers-bin.test.js`** (new) — behavioral test (real temp
  files), 4 cases. Passes.

### Compose
- **`docker-compose.yml`** — portable base: env-driven, **tag-based** image refs by
  default, hub published on `HUB_PORT` (8080), secrets via `${VAR}`/.env, soft
  `cpus`/`mem_limit`, hub healthcheck (port-aware). Optional **`proxy` profile**
  (Caddy TLS) for self-hosters with no gateway. Runner docker-build access OFF by
  default.
- **`deploy/compose/Caddyfile`** — config for the `proxy` profile.
- **`deploy/compose/runner-docker-socket.yml`** — optional overlay to give the
  runner docker-build access via the host/guest socket (DinD alternative documented).
- **`docker-compose.local.yml`** — dev override (locally-built images + placeholder
  token).
- **`deploy/dstack/docker-compose.dstack.yml`** — dstack overlay: `@sha256:` digest
  placeholders (REQUIRED for attestation), hub → `:80` behind gateway (no proxy),
  `UPDATE_APPLY_ENABLED=0`, guest docker socket. Rendered into a single app-compose
  via `docker compose -f docker-compose.yml -f deploy/dstack/... config`.
- **`.dockerignore`** — keeps node_modules/.git/worktrees/secrets/logs/screenshots
  out of the build context.

### CI
- **`.github/workflows/images.yml`** — on `v*` tags, re-runs `pnpm test` (gate) then
  builds + pushes both images to `ghcr.io/yolo-maxi/runyard-{hub,runner}`,
  publishing semver/sha tags AND emitting `@sha256:` digests to the job summary +
  a `dstack-image-digests` artifact. Existing `release.yml` test gate untouched.

### Docs
- **`DEPLOY.md`** — generic guide: build/push, portable run, optional proxy +
  runner-docker toggle, digest pinning (best practice everywhere), **APPLY per
  target** (compose pull / k8s rollout / host `runyard update` / dstack UpgradeApp),
  storage, hub↔runner comms.
- **`deploy/dstack/README.md`** — dstack overlay specifics: render app-compose,
  digest-pin REQUIRED, `:80`-behind-gateway, UpgradeApp update/rollback, disk
  sizing, boot limits, guest docker, and the "verify on target" list.

## Eval gates — status

| Gate | Result |
| ---- | ------ |
| `docker build -f Dockerfile.hub .` | ✅ OK (~362 MB) |
| `docker build -f Dockerfile.runner .` | ✅ OK (~759 MB); node 22.23.1 / bun 1.3.14 / git 2.39.5 / docker 29.6.0 / smithers 0.25.1 |
| `docker compose config` (base, +proxy, +socket overlay, +dstack overlay) | ✅ all validate |
| Stack up locally (dev profile) — hub `/healthz` + `/version` | ✅ 200 on :8080 |
| Runner starts, has bun/smithers/git/docker, dials the hub | ✅ surface verified; dial-in reached hub `/api/runners/register` → `unauthorized` (expected with placeholder token) |
| Touched-code tests (`resolve-smithers-bin`, `smithers-runner-source`) | ✅ 8/8 pass |
| Full `pnpm test` | ⚠️ 171 pass / 12 fail — the **same 12 files fail on the base commit `38089cc`** (verified via a clean worktree). Pre-existing & environment-specific; **no regression** from this work. |

Note: builds use plain `docker build` (no BuildKit-only `--mount=type=cache`), so
the gate passes on the default builder.

## Open "verify on target" items (real dstack CVM only)
1. app-compose parser policy for `privileged:` / `/var/run/docker.sock` mounts —
   else use a rootless DinD sidecar.
2. On-chain KMS may require the new compose-hash to be authorized in the app
   registry before an upgraded CVM can unseal (extra on-chain tx per rollout/rollback).
3. Default/create-time disk size must hold hub datastore + largest runner workspace
   (no elastic growth).
4. dstack-gateway → container `:80` default mapping.
5. Public GHCR pull from inside the CVM (no creds).

## Pre-existing failing tests (NOT introduced here)
api, capability-versioning, cli-mcp, product-workflow, run-smithers-watcher,
run-timeline, runner-heartbeat-auth, schedules, secrets-api, supervision,
update-endpoints, workflow-source — identical set on base `38089cc`.
