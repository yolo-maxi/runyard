# Goal: Containerize RunYard for dstack (Intel TDX confidential VMs) + GHCR

You are in a git worktree at `/home/xiko/smithers-hub-worktrees/docker-dstack` on branch
**`feat/docker-dstack`** (off `main`). This is RunYard (`smithers-hub`): a Node/Express **hub**
(control plane + web UI + embedded SQLite/PGlite datastore) and a **runner** that executes
long-running AI coding/deployment workflows by shelling out to the `smithers` CLI
(`smithers-orchestrator`, a **bun** app). **Do NOT touch other worktrees.** This is a
packaging/infra task — do not change app business logic or the DB schema. Additive files only
(Dockerfiles, compose, CI, .dockerignore, docs); minimal edits to existing files only where
strictly required (e.g. a `resolveSmithersBin` helper, port/env handling).

## Deployment target: dstack on Intel TDX (read carefully — it reshapes the design)

Each RunYard deployment is its **own confidential VM (CVM)** — NOT a shared k8s/Docker cluster.
dstack runs your `docker-compose` with a **full Docker daemon inside the CVM guest**. The CVM
boundary is the hardware-attested tenant isolation boundary. You own the guest (its kernel,
dockerd, encrypted disk); you have zero access to the bare-metal host.

Hard platform constraints (design to these exactly):

1. **Docker-in-CVM is the sanctioned path.** Inside the CVM you own dockerd, so the runner MAY
   use the guest Docker socket or a rootless DinD sidecar to run `docker build` / containerized
   build steps per workflow run. Never assume access to the bare-metal host socket. Recommended
   model: a long-lived **runner CVM running the guest dockerd**, executing each run as an internal
   container. (Assumption to flag, not block on: dstack's app-compose parser may restrict
   `privileged:`/socket mounts — note it in the docs as "verify on target".)
2. **Persistent storage is a KMS-encrypted per-CVM disk.** Named volumes / bind mounts survive
   container recreation and CVM reboot, but NOT app destruction (RemoveVm). Disk size is fixed at
   create time (no elastic growth) — size deliberately. Put the **hub datastore on a named
   volume**; treat **runner workspaces** as large scratch on the runner's disk (persist only what
   matters back to the hub).
3. **GHCR pull works, but you MUST pin every image by `@sha256:` digest, never a mutable tag.**
   dstack attestation measures the compose *text*; a `:latest`/`:vX` tag commits to the string,
   not the bytes, so it would not bind your code. The compose file must reference images by
   digest. This also means **no auto-pull/Watchtower** (see #6). Private images would use dstack
   encrypted env vars for creds — but our images are public GHCR, so plain digest refs are fine.
4. **Ingress + TLS are provided by dstack-gateway.** It terminates TLS and reverse-proxies to your
   container at `https://<app_id>.gateway.attestmesh.xyz/` → **container port 80 by default**. So:
   **the hub must listen on / be exposed at port 80**, and we **do NOT ship Caddy or our own TLS.**
   Drop any reverse-proxy from the stack.
5. **Egress is open** (AI APIs, git, npm/pnpm registries all reachable). No proxy/allowlist.
6. **Updates are via dstack `UpgradeApp`, NOT `docker compose pull`.** Operator swaps the
   app-compose (new digests → new compose-hash → re-measured), keeping the same `app_id`, KMS
   keys, and disk. **Rollback = UpgradeApp back to the previous compose (previous digests).** This
   **replaces RunYard's host-side self-update APPLY** (`runyard update` git-checkout/rollback) —
   that mechanism is not used on dstack. Keep the **CHECK** side (version/digest awareness) as
   *informational only* and clearly document that APPLY = dstack UpgradeApp. (Gotcha to document:
   on-chain KMS may require the new compose-hash to be authorized in the app registry before an
   upgraded CVM can unseal — an extra on-chain tx per rollout; flag as "verify on target".)
7. **Resource limits set at CVM create; boot is the real limiter** (~40s serialized cold starts,
   ~90 boots/host/hr). So **do NOT spin a CVM per run.** Long-lived runner CVM, runs as internal
   containers. Bound each build with compose `cpus`/`mem_limit` inside the CVM.

## Deliverables

1. **`Dockerfile.hub`** — multi-stage, node 22 + pnpm. Installs deps (`--frozen-lockfile`), builds
   the web bundle (`pnpm build:vendor` + `pnpm build:web`), runs the hub server. Listens on **port
   80** (make the port configurable but default 80 for the gateway). Datastore path points at a
   mounted volume. Non-root user where practical. Small final image.
2. **`Dockerfile.runner`** — node 22 + pnpm **+ bun (≥1.3)** + **pinned `smithers-orchestrator`**
   (install via `bun add -g smithers-orchestrator@<PIN>`; choose a current pinned version and put
   it in a build ARG so it's explicit/reproducible) + **git** + the **docker CLI** (to talk to the
   guest dockerd) + an agent CLI placeholder (document that `claude`/`codex` must be provided/authed;
   don't bake secrets). Runs `src/smithers-runner.js` pointing at `SMITHERS_HUB_URL` +
   `SMITHERS_HUB_TOKEN`. Workspace on a mounted volume.
3. **Small `resolveSmithersBin()` helper** in the runner (env `SMITHERS_BIN` → known global bun
   path → `smithers` on PATH) so the pinned engine is used deterministically. Update the runner's
   invocation to use it. Keep it minimal and tested.
4. **`docker-compose.yml`** for dstack — two services `hub` + `runner`, **images pinned by
   `@sha256:` digest** (use clear `# REPLACE_WITH_DIGEST` placeholders + a documented step, since
   digests only exist after the first CI push), named volume for hub data, scratch volume for
   runner workspace, hub exposed on **:80**, env wiring for hub URL/token + agent API keys via
   dstack encrypted env (referenced, not inlined), `cpus`/`mem_limit` examples, and the runner set
   up for guest-docker access (documented DinD/socket option). **No Caddy.**
5. **`.dockerignore`** — keep node_modules, .git, other worktrees, secrets, logs, screenshots out
   of build context.
6. **GHCR CI** — extend/add a workflow that, on a pushed `v*` tag (after tests pass), **builds and
   pushes both images to `ghcr.io/yolo-maxi/runyard-hub` and `ghcr.io/yolo-maxi/runyard-runner`**,
   and **emits the resulting `@sha256:` digests** into the job summary / a release artifact so the
   operator can paste them into the compose for an UpgradeApp. Keep the existing test gate.
7. **`DEPLOY-DSTACK.md`** — the operator guide: build/push flow, where digests come from, how to
   fill the compose, the **UpgradeApp** update + rollback model (explicitly: not `compose pull`, no
   Watchtower), the hub-on-:80-behind-gateway URL shape, disk-sizing guidance, hub↔runner comms
   (separate VMs, via gateway or direct addr + token), and a clearly-labelled list of
   **"verify on target"** assumptions (privileged/socket parser policy #1, on-chain compose-hash
   auth for UpgradeApp #6, default disk size).

## Eval gates — loop until green before declaring done

- `docker build -f Dockerfile.hub .` and `docker build -f Dockerfile.runner .` both succeed.
- `docker compose config` validates the compose file.
- Bring the stack up locally (`docker compose up`, with a placeholder token + a public test image
  or the locally-built images): **hub answers on its port** (`/healthz`, `/version`), and the
  **runner container starts, has `bun`, the pinned `smithers --version`, `git`, and `docker`
  available**, and attempts to register with the hub (registration may fail without a valid token —
  that's fine; prove the binary/runtime surface and the dial-in attempt).
- Existing backend suite still green (`pnpm test`) for any code you touched.
- Document anything you could not verify locally (e.g. real dstack attestation) under
  "verify on target" rather than skipping silently.

## Working rules

- Commit frequently to `feat/docker-dstack` with clear messages. Do NOT merge to main, tag, or
  deploy — that's the operator's call.
- Prefer additive files; touch existing source only where required (port/env, resolveSmithersBin).
- When you stop, append `DOCKER-DSTACK-STATUS.md`: what's built, gate status, open "verify on
  target" items.
