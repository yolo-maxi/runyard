# Acceptance and Manual Tests

This file captures user-facing acceptance criteria and manual tests for Runyard.

## Acceptance Criteria

### Deployment

- `https://runyard.repo.box/` serves the public static landing page.
- `https://runyard.repo.box/docs` serves public installation and topology docs.
- `https://hub.repo.box/` may serve the same product landing inside the live deployment, but the live operations surface is `https://hub.repo.box/app`.
- `https://hub.repo.box/app` serves the token-protected operations console.
- `https://hub.repo.box/llms.txt` describes the agent-facing surface.
- `https://hub.repo.box/openapi.json` describes the HTTP API.
- `smithers-hub.service` is active on repo.box.
- Higher-capacity runners are active on worker machines, not on the serving box.
- The landing page, docs, README, and specs explain workflow hardening: agentic workflows should progressively split into smaller steps, extract repeatable scripts, and harden into deterministic code where appropriate.

### Authentication

- A bootstrap token exists at `data/bootstrap-token.txt` on first deployment.
- The Web Hub accepts a valid token and creates a long-lived browser session.
- API, CLI, MCP, and runner requests work with bearer tokens.
- Invalid tokens are rejected.

### Capability Catalog

- The catalog includes the seed capabilities:
  - Review Pull Request
  - Research Topic
  - Prepare Spec
  - Implement
  - Run Smithers Workflow
- Each capability exposes:
  - name
  - description
  - category
  - keywords
  - input schema
  - output schema
  - required runner tags
  - required skills
  - required agents
  - approval policy
  - workflow metadata
- Capabilities are editable through the Web Hub.

### Workflow Detail (Code viewer + ReactFlow visualizer)

- The workflow detail page exposes four tabs: **Overview**, **Visual graph**, **Code**, **Runs**, all reachable via deep links (`#workflows/<slug>/<tab>`).
- The **Code** tab shows the actual workflow source with highlight.js syntax highlighting, virtual sub-tabs (Code / Agents / workflowGraph), a copy-source action, and an internal scroll container (no horizontally overflowing blob).
- The **Visual graph** tab renders an interactive ReactFlow canvas (pan, wheel zoom, fit/reset, minimap) over the parsed workflow graph; the entry node connects to inferred tasks/steps with sequence/parallel edges, and approval/test/commit/push/deploy gates are colour-coded when inferable.
- A static SVG fallback is rendered only when the vendored ReactFlow bundle fails to load.
- Required agents/skills/runner tags appear as side pills on the graph.
- The workflow source + parsed graph are available via `/api/capabilities/<slug>/source` for the CLI/MCP clients.
- No horizontal overflow on phones — both the graph host and the code viewer scroll internally.

### Runs and Artifacts

- A capability run creates a durable run record.
- The run detail view shows input, status, current step, event timeline, artifacts, and output.
- Run cards and run detail show artifacts in the context of their owning run; there is no standalone Artifacts page in the human console.
- Runner events are persisted.
- Uploaded artifacts are stored on disk and downloadable through the Web/API.
- Completed runs remain visible after execution.

### Approvals

- Capabilities with approval policies start normally; only explicit in-workflow approval checkpoints enter `waiting_approval`.
- Pending approvals appear in the Web approval inbox.
- Approval can be resolved through Web/API/CLI/MCP.
- Approved runs move back to `queued`.
- Rejected runs are cancelled.
- Telegram notifications are sent when Telegram is configured.

### Runner

- A runner can register with tags.
- A runner heartbeat is visible in the Web Hub.
- A matching runner can execute queued seed capabilities.
- Local machines can start a runner with `SMITHERS_HUB_URL` and `SMITHERS_HUB_TOKEN`.

### MCP

- MCP initializes successfully.
- `tools/list` returns the Hub tool set.
- `get_menu` returns the discovery path, local/remote execution choices, and Hub follow-up paths for outputs and artifacts.
- `list_capabilities` returns seed capabilities.
- `run_capability` creates a run.
- `run_capability` accepts `executionMode: "local"` and `executionMode: "remote"` and the run detail records the execution intent.
- `get_run_status`, `get_run_logs`, and `get_run_artifacts` inspect the run.
- `list_pending_approvals`, `approve_run`, and `reject_run` operate on centralized approvals.

### CLI

- `smithers-hub login` stores config.
- `smithers-hub menu` shows the discovery path and local/remote run choices.
- `smithers-hub capabilities` lists the catalog.
- `smithers-hub capability <id>` describes one capability.
- `smithers-hub run <capability-id> --where local|remote` starts a run and records execution intent.
- `smithers-hub runs` lists runs.
- `smithers-hub logs <run-id>` prints event logs.
- `smithers-hub artifacts <run-id>` lists artifacts.
- `smithers-hub approvals` lists pending approvals.
- `smithers-hub approve <approval-id>` and `smithers-hub reject <approval-id>` resolve approvals.
- `smithers-hub runner start` starts a foreground runner.
- `smithers-hub mcp install` prints MCP config.

## Automated Tests

Run:

```bash
pnpm test
```

Covered by the current automated tests:

- Bootstrap token authentication.
- Seeded capability, agent, skill, and knowledge records.
- Run creation.
- Runner registration.
- Run claiming.
- Event creation.
- Artifact upload/storage.
- Run completion.
- Approval-required run creation.
- Approval resolution.

## Manual Smoke Tests

### Web Smoke

1. Open `https://hub.repo.box/app`.
2. Log in with the deployment bootstrap token.
3. Open the Capability Catalog.
4. Run `hello` with a short topic and either `--where local` or `--where remote`.
5. Open the run detail page.
6. Confirm the run succeeds.
7. Download `implementation-spec.md`.

### Approval Smoke

1. Run the `Implement` capability.
2. Confirm the run starts as `queued` or is picked up by a matching runner.
3. Open Approvals.
4. Approve the request.
5. Confirm the run moves to `queued`.
6. Confirm the runner picks it up if tags match.

### CLI Smoke

```bash
smithers-hub login --url https://hub.example.com --token shub_...
smithers-hub menu
smithers-hub capabilities
smithers-hub run hello --where local --input '{"topic":"Smithers Hub CLI smoke"}'
smithers-hub runs
smithers-hub artifacts <run-id>
```

### MCP Smoke

Send two JSON-RPC messages to `smithers-hub-mcp`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_menu","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_capability","arguments":{"id":"hello","input":{"topic":"Smithers Hub MCP smoke"},"executionMode":"remote"}}}
```

Expected result:

- Initialize returns server info.
- `get_menu` explains discovery, local/remote execution, and Hub artifact retrieval.
- `run_capability` creates a Hub run whose detail includes `execution.mode=remote`.

### Runner Smoke

```bash
SMITHERS_HUB_URL=https://hub.example.com \
SMITHERS_HUB_TOKEN=shub_... \
SMITHERS_RUNNER_TAGS=linux,node,git,shell,web,smithers \
smithers-hub-runner
```

Expected result:

- Runner registers.
- Runner appears online in the Web Hub.
- Runner claims matching queued runs.
