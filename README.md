# Smithers Hub

Smithers Hub is a self-hosted capability operating system for company agents. It runs on a private domain, exposes a capability catalog through MCP/CLI/API/Web, dispatches work to local or remote runners, and stores logs, events, artifacts, approvals, skills, agents, and knowledge centrally.

## Connect in one line

Install the CLI + MCP client (needs Node.js 18+). It asks you to paste an access token:

```bash
bash <(curl -fsSL https://hub.repo.box/install.sh)
```

Then connect every AI agent on the machine — writes the config for you, no JSON editing:

```bash
smithers-hub mcp install --all     # auto-detects Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code
smithers-hub mcp install --client codex   # or target one
```

### Multiple orgs (remotes)

Each org is its own hub, like a git remote. Add more on the same machine:

```bash
smithers-hub login --remote acme --url https://acme-hub.example   # prompts for that org's token
smithers-hub mcp install --all --remote acme                      # installs as `smithers-hub-acme`
smithers-hub remote use acme                                      # switch the default target
smithers-hub remotes                                              # list them
```

To onboard a teammate, open the **Connect** tab in the Web Hub, generate a token, and send them the install command + token — they paste it when prompted.

## Run locally

```bash
pnpm install
pnpm start
```

Open `http://127.0.0.1:43117/app`. On first start the server creates `data/bootstrap-token.txt`; use that token to log in.

## Deploy shape

- Node server with SQLite.
- Local disk artifacts under `data/artifacts`.
- Access-token auth only.
- One private deployment per company/org.
- Runners can run on VPS, Linux workstations, or macOS laptops.

## Agent interfaces

Discovery:

- `/llms.txt`
- `/openapi.json`
- MCP server: `smithers-hub-mcp`
- CLI: `smithers-hub`

CLI:

```bash
smithers-hub login --url https://hub.repo.box --token shub_...
smithers-hub capabilities
smithers-hub capability prepare-spec
smithers-hub run prepare-spec --input '{"goal":"Prepare a rollout spec"}'
smithers-hub runs
smithers-hub approvals
smithers-hub approve appr_...
```

MCP config:

```json
{
  "command": "smithers-hub-mcp",
  "env": {
    "SMITHERS_HUB_URL": "https://hub.repo.box",
    "SMITHERS_HUB_TOKEN": "shub_..."
  }
}
```

Runner:

```bash
SMITHERS_HUB_URL=https://hub.repo.box \
SMITHERS_HUB_TOKEN=shub_... \
SMITHERS_RUNNER_TAGS=linux,node,git,shell,web,smithers \
smithers-hub-runner
```

## Included capabilities

- Review Pull Request
- Research Topic
- Prepare Spec
- Implement
- Run Smithers Workflow

The seed capabilities are editable from the Web Hub and exposed through MCP, CLI, and HTTP.

## Environment

Copy `.env.example` and set deployment values.

Required for production:

- `BASE_URL`
- `PORT`
- `SMITHERS_HUB_SESSION_SECRET`
- `SMITHERS_HUB_BOOTSTRAP_TOKEN` or machine access to read `data/bootstrap-token.txt`

Optional:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

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

## Specs

The durable product/spec record lives in `specs/`:

- `specs/product-intent-and-user-expectations.md`
- `specs/implementation-decisions.md`
- `specs/acceptance-and-manual-tests.md`
