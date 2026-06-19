# Runyard

**Self-hosted control plane for agent runs.**

Runyard (codebase name: `smithers-hub`) is a self-hosted capability operating system for company agents. It runs on a domain you own, exposes a capability catalog through MCP/CLI/API/Web, dispatches work to local or remote runners, and stores logs, events, artifacts, approvals, skills, agents, and knowledge centrally.

The package name, bin names, environment variables (`SMITHERS_HUB_*`), and tokens all keep the `smithers-hub` prefix so existing deployments and tokens keep working. "Runyard" is the public product name and the name we use for issues, releases, and docs going forward.

## Why

Local agent sessions scatter the same things every team needs: which workflows are available, which skills/agents/knowledge to reuse, what ran when, what artifacts exist, what is waiting on a human. Runyard centralises that record on a box you control — no SaaS dependency, no shared multi-tenant database. One private deployment per company/org.

## Install

Requirements:

- Node.js 22.5+ (the server uses `--experimental-sqlite`)
- `pnpm`
- A writable `data/` directory

```bash
git clone https://github.com/yolo-maxi/runyard
cd runyard
pnpm install
pnpm build:vendor   # vendors highlight.js + react-flow for the workflow viewer
```

If you already have a Hub running, you can install just the CLI + MCP client (Node.js 18+) from it:

```bash
bash <(curl -fsSL https://hub.example.com/install.sh)
```

(`hub.example.com` is an example deployment — substitute your own domain.)

## Run locally

```bash
PORT=43117 BASE_URL=http://127.0.0.1:43117 pnpm start
# the server writes data/bootstrap-token.txt on first boot
open http://127.0.0.1:43117/app
```

Use the bootstrap token to log in. Issue more tokens from the **Connect** tab.

## Connect every agent in one line

```bash
smithers-hub mcp install --all     # auto-detects Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code
smithers-hub mcp install --client codex   # or target one
```

### Multiple orgs (remotes)

Each org is its own hub, like a git remote:

```bash
smithers-hub login --remote acme --url https://acme-hub.example   # prompts for that org's token
smithers-hub mcp install --all --remote acme                      # installs as `smithers-hub-acme`
smithers-hub remote use acme                                      # switch the default target
smithers-hub remotes                                              # list them
```

To onboard a teammate, open the **Connect** tab in the Web Hub, generate a token, and send them the install command + token — they paste it when prompted.

## Topology Options

Runyard is built for one private Hub per company/org. The repo is generic; our own deployment is just one topology.

Recommended private org topology:

- Hub server: small VPS running Node + SQLite behind Caddy/nginx/Traefik.
- Data: local SQLite and artifacts under `SMITHERS_HUB_DATA_DIR`; back up this directory.
- Runners: separate VPSes, Linux workstations, or macOS laptops that poll the Hub over HTTPS.
- Queue: centralized in the Hub. Runners never touch SQLite directly.
- Auth: Hub-issued bearer tokens for Web, API, CLI, MCP, and runners.

Small/local topology:

- Run the Hub and one runner on the same machine.
- Use `BASE_URL=http://127.0.0.1:43117` while developing.
- Keep runner capacity low unless the machine is dedicated to builds.

Dedicated runner pool topology:

- Keep the Hub as the lightweight control plane.
- Run one or more runner processes on worker VPSes.
- Set `SMITHERS_RUNNER_CAPACITY` / `SMITHERS_RUNNER_CONCURRENCY` according to CPU and memory.
- Use runner tags such as `linux`, `browser`, `gpu`, `dangerous`, or `deploy` to route work.

Public docs + private Hub topology:

- Serve the marketing/setup docs as a static site.
- Keep `/app`, API, MCP, SQLite, artifacts, and runner tokens on the private Hub deployment.
- This repo's own public docs live at `https://runyard.repo.box`; the live operations Hub stays at `https://hub.repo.box`.

Our current topology:

- `runyard.repo.box`: static landing/setup docs only.
- `hub.repo.box`: live token-protected Runyard Hub.
- repo.box serves production web traffic.
- A separate Hetzner worker host runs the higher-capacity runner pool, so builds and agent work do not compete with the serving box.

## Agent interfaces

Discovery:

- `/llms.txt`
- `/openapi.json`
- MCP server: `smithers-hub-mcp`
- CLI: `smithers-hub`

CLI:

```bash
smithers-hub login --url https://hub.example.com --token shub_...
smithers-hub capabilities
smithers-hub capability prepare-spec
smithers-hub run prepare-spec --input '{"goal":"Prepare a rollout spec"}'
smithers-hub runs
smithers-hub runners
smithers-hub approvals
smithers-hub approve appr_...
```

MCP config:

```json
{
  "command": "smithers-hub-mcp",
  "env": {
    "SMITHERS_HUB_URL": "https://hub.example.com",
    "SMITHERS_HUB_TOKEN": "shub_..."
  }
}
```

Runner:

```bash
SMITHERS_HUB_URL=https://hub.example.com \
SMITHERS_HUB_TOKEN=shub_... \
SMITHERS_RUNNER_NAME=hetzner-vps-runner \
SMITHERS_RUNNER_LOCATION=vps \
SMITHERS_RUNNER_TAGS=linux,node,git,shell,web,smithers \
SMITHERS_RUNNER_CAPACITY=4 \
smithers-hub-runner
```

## Included capabilities

- Hello (Smithers proof)
- Research
- Implement
- Smart Contract Audit
- Implement Change (gated)
- Idea to Product
- App Skinner
- Run Knowledge Builder

The seed capabilities are editable from the Web Hub and exposed through MCP, CLI, and HTTP.

## Environment

Copy `.env.example` (if present) and set deployment values.

Required for production:

- `BASE_URL`
- `PORT`
- `SMITHERS_HUB_SESSION_SECRET`
- `SMITHERS_HUB_BOOTSTRAP_TOKEN` or machine access to read `data/bootstrap-token.txt`

Optional:

- `SMITHERS_HUB_INSTANCE_NAME` — label the deployment in `/api/version`.
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_APPROVAL_CHAT_ID` or `SMITHERS_TELEGRAM_APPROVAL_CHAT_ID` for private approval DMs (preferred)
- `TELEGRAM_CHAT_ID` and `TELEGRAM_THREAD_ID` remain a backward-compatible fallback when a private approval chat is not configured

Runner-side variables (used by `smithers-hub-runner`):

- `SMITHERS_HUB_URL`, `SMITHERS_HUB_TOKEN`
- `SMITHERS_RUNNER_NAME`, `SMITHERS_RUNNER_LOCATION`, `SMITHERS_RUNNER_TAGS`, `SMITHERS_RUNNER_CAPACITY`
- `SMITHERS_WORKSPACE` — scratch directory for Smithers workflows

## Security model

- Single auth primitive: every surface (Web, API, CLI, MCP, runner) authenticates with a Hub access token.
- Private deployment: Runyard is meant for one org per deployment. There is no multi-tenant SaaS database.
- Public/docs split: if you expose a public landing page, keep it static. Do not expose `/app`, runner tokens, SQLite files, artifacts, or deployment env files publicly.
- Bootstrap token: the first token is written to `data/bootstrap-token.txt` — rotate it via the Connect tab.
- Scopes: API tokens can be scoped (`api`, `mcp`, `approvals`) so approvers can be issued narrower keys.
- Runners execute work on behalf of authenticated requests; isolate sensitive runners by tag set.
- Strict CSP, `x-content-type-options`, `referrer-policy`, and HSTS (when served over HTTPS) are set by the server.
- Login and general API buckets are rate-limited.

## Verification

```bash
pnpm test
```

Manual checks:

1. Log in to `/app` with the bootstrap token.
2. Run `Prepare Spec`.
3. Start a runner and confirm the run succeeds.
4. Open the run detail page and download the generated artifact.
5. Run `Implement`; approve it through Web or MCP; confirm it queues and executes.
6. Configure a local MCP client with `smithers-hub-mcp` and call `list_capabilities`.

## Open source & contributions

Runyard is open source under the MIT license. The directories that matter:

- `bin/` — CLI/MCP/runner entry points
- `src/` — server, CLI, MCP, runner, db, security
- `public/` — landing, docs, console
- `specs/` — product intent, decisions, acceptance checks
- `workflow-templates/` — bundled Smithers workflows
- `tests/` — Node test runner

Conventions:

- Treat hostnames like `hub.example.com` as examples only. Do not hard-code private hostnames in new code or docs.
- File issues and PRs against the public Runyard repo.
- The gated pipeline runs `pnpm test`, `git diff --check`, and smoke-checks `/healthz`, `/app`, `/docs`, `/llms.txt` before deploy.

## Specs

The durable product/spec record lives in `specs/`:

- `specs/product-intent-and-user-expectations.md`
- `specs/implementation-decisions.md`
- `specs/acceptance-and-manual-tests.md`
