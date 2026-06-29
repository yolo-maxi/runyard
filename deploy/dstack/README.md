# RunYard on dstack (Intel TDX confidential VMs)

This overlay applies **only** the dstack-specific bits on top of the portable
base (`../../docker-compose.yml`). For generic build/run/update docs see the
top-level [`DEPLOY.md`](../../DEPLOY.md); this file covers what is different on
dstack.

> Each RunYard deployment is its **own CVM** — not a shared cluster. dstack runs
> your compose with a full Docker daemon **inside the CVM guest**. The CVM
> boundary is the hardware-attested tenant isolation boundary. You own the guest
> (kernel, dockerd, KMS-encrypted disk); you have no access to the bare-metal host.

Files:
- `docker-compose.dstack.yml` — the overlay (digest pins, `:80`, UpgradeApp wiring,
  guest-docker socket).

---

## 1. Render the app-compose

dstack measures the **compose text**, so deploy a single, self-contained file.
Render it by merging the base with this overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/dstack/docker-compose.dstack.yml \
  config > app-compose.yml
```

`app-compose.yml` is what you hand to dstack. Re-render whenever either input
changes (re-rendering changes the compose-hash → re-measured).

---

## 2. Digest pinning is REQUIRED

dstack attestation measures the compose text. A mutable tag (`:latest`, `:0.1.0`)
commits to the *string*, not the *bytes*, so it would not bind your code to the
attestation. **Every image MUST be pinned by `@sha256:` digest.**

The overlay ships placeholders:

```yaml
  hub:
    image: ghcr.io/yolo-maxi/runyard-hub@sha256:REPLACE_WITH_HUB_DIGEST
  runner:
    image: ghcr.io/yolo-maxi/runyard-runner@sha256:REPLACE_WITH_RUNNER_DIGEST
```

Get digests from the CI run (job summary or the `dstack-image-digests` artifact),
or `docker buildx imagetools inspect <image>:<tag>`, paste them in, then re-render.
Both GHCR packages must be **public** so the CVM can pull without creds. (Private
images would use dstack encrypted env for registry creds — not needed here.)

---

## 3. Ingress: hub on :80 behind dstack-gateway (NO bundled proxy)

dstack-gateway terminates TLS and reverse-proxies to your container on **port 80**:

```
https://<app_id>.gateway.attestmesh.xyz/  →  hub container :80
```

So the overlay sets the hub to `PORT=80` and publishes `80:80`. **Do not** enable
the base `proxy` profile — the gateway already does TLS. The hub image grants the
node binary `cap_net_bind_service`, so it binds :80 as a non-root user.

Set `BASE_URL` to the gateway hostname so https links + production session mode are
correct (the overlay defaults it to `https://APP_ID.gateway.attestmesh.xyz` —
replace `APP_ID`).

---

## 4. Secrets — dstack encrypted env

Provide secrets through dstack's **encrypted env** for the app (never inline them
in the compose): `RUNYARD_HUB_SESSION_SECRET`, `RUNYARD_HUB_BOOTSTRAP_TOKEN`,
`SECRETS_ENC_KEY` (hub); `RUNYARD_HUB_TOKEN`, `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` (runner). The compose references them as `${VAR}` only.

The dstack overlay also enables the runner-native CLI subscription re-auth path:
the runner advertises the `reauth` tag, sets `REAUTH_ENABLED=1`, and sets
`HOME=/runner-home`. Hub-triggered `reauth-cli` runs then execute on this CVM
runner and write CLI auth files to the persistent runner home:

- Codex: `/runner-home/.codex/auth.json`
- Claude subscription login: `/runner-home/.claude/.credentials.json`
- Claude CI/headless token from `claude setup-token`: `/runner-home/.claude/oauth-token`

Anthropic's `claude setup-token` is meant to be run on a machine where the
operator can log into Claude normally. It prints a long-lived
`CLAUDE_CODE_OAUTH_TOKEN` and does not save it. In the Hub, use **Connect
Claude** on the runner card: paste that token into the write-only field, and
RunYard sends it once to the selected runner via the encrypted one-run secret
claim payload. The runner stores it in `oauth-token` with mode `0600` and
injects it into future Claude CLI jobs as `CLAUDE_CODE_OAUTH_TOKEN`. The token
value is never returned through Hub outputs, logs, or artifacts.

Those auth files live on the same encrypted per-CVM disk as named volumes. They
survive container recreation, `UpgradeApp`, and CVM reboot as long as the same
app/disk/KMS keys are kept. They do **not** survive app destruction.

---

## 5. Storage & disk sizing

- Persistence = a **KMS-encrypted, per-CVM disk**. Named volumes survive container
  recreation and CVM reboot, but **NOT app destruction** (`RemoveVm` wipes the disk
  and its KMS keys).
- **Disk size is fixed at create time** — no elastic growth. Size deliberately.
- Hub datastore (`hub-data`) is small/long-lived — keep it on the volume. Runner
  workspace (`runner-workspace`) is large scratch; persist only what matters back
  to the hub (it already uploads outputs + traces as artifacts). Runner HOME
  (`runner-home`) is small/long-lived and stores CLI auth state for `reauth-cli`.
- Starting point: hub data a few GB; runner workspace 20–50 GB by repo size. You
  cannot grow it after create.

---

## 6. Updates & rollback — dstack UpgradeApp (NOT compose pull)

On dstack, **APPLY = `UpgradeApp`**. RunYard's host-side self-update *apply* path is
disabled here (`UPDATE_APPLY_ENABLED=0`); the in-app update **CHECK** stays on as
**informational only**.

To update:
1. CI builds new images on a new tag → new digests.
2. Swap the new digests into the overlay, re-render `app-compose.yml`.
3. Run **`UpgradeApp`** with the new compose, keeping the **same `app_id`, KMS
   keys, and disk**. The new compose-hash is re-measured/attested.

To roll back: **`UpgradeApp` back to the previous compose** (previous digests) —
same `app_id`/keys/disk. Rollback is just an upgrade to the older measured compose.
**No Watchtower, no `docker compose pull`, no auto-pull.**

---

## 7. Resource limits & boot behavior

- Resource ceilings are set at **CVM create**; cold boot is the real limiter
  (~40 s serialized cold starts, ~90 boots/host/hr).
- **Do NOT spin a CVM per run.** Use a long-lived runner CVM and execute each run
  as work inside it. Bound individual builds with the compose `cpus`/`mem_limit`
  (these cap usage *within* the CVM; the hard ceiling is the CVM's create sizing).

---

## 8. Guest Docker access for the runner

Inside the CVM you own dockerd, so the runner may build containers per run. The
overlay mounts the **guest** CVM socket `/var/run/docker.sock` (you own it — never
the bare-metal host socket) and sets `DOCKER_HOST`. If the app-compose parser
forbids socket mounts, switch to a rootless DinD sidecar (see `DEPLOY.md`).

---

## ⚠️ Verify on target

Confirm each on a real dstack CVM before relying on it:

1. **app-compose parser policy:** dstack may restrict `privileged:` and/or
   host-socket mounts (`/var/run/docker.sock`). If rejected, use a rootless DinD
   sidecar. Confirm what the parser allows.
2. **On-chain compose-hash authorization for UpgradeApp:** on-chain KMS may require
   the new compose-hash to be **authorized in the app registry before** an upgraded
   CVM can unseal its disk — an extra on-chain tx per rollout (and per rollback,
   since rollback is also an upgrade). Confirm the exact flow for your KMS.
3. **Default disk size:** confirm the create-time disk size holds the hub datastore
   + the largest runner workspace you expect. It cannot be grown after create.
4. **Gateway → :80 default:** confirm dstack-gateway proxies to container port 80
   for your app; adjust `PORT`/published port if your gateway maps differently.
5. **GHCR pull from inside the CVM:** confirm the public GHCR packages pull from the
   CVM's egress without credentials.
