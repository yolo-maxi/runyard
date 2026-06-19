# Implementation Decisions

This file records the implementation decisions made for the current Runyard build.

## Product and Deployment Model

### Decision: Private installable product, not hosted SaaS

Runyard is built as one private deployment per company.

Reasoning:

- The user wants to run separate Hubs for separate organizations.
- Each org should own its own domain, machine, tokens, runners, and data.
- Multi-org SaaS auth and billing would add complexity that does not serve the current product model.

Expectation:

- `hub.example.com` is a representative company deployment.
- Another org can deploy the same repo to a different machine/domain.

### Decision: public docs can be split from the private Hub

The open-source project supports a public static landing/setup site while the live operations Hub remains private.

Reasoning:

- Setup docs are safe to publish broadly.
- The Web console, API, MCP endpoint, runner tokens, SQLite database, artifacts, and environment files are operational surfaces and should stay on the private Hub.
- A public docs site lets outsiders understand the topology without exposing our live deployment.

Current project deployment:

- Public static docs: `https://runyard.repo.box`.
- Live operations Hub: `https://hub.repo.box`.
- The serving box handles production web traffic.
- Higher-capacity runner work is assigned to a separate worker host so builds do not compete with serving traffic.

### Decision: Port `43117`

Smithers Hub listens on local port `43117`.

Reasoning:

- Existing repo.box services already occupy many lower ports and several `431xx` ports.
- `43117` was unused during deployment checks.

## Runtime Stack

### Decision: Node 22, Express, built-in SQLite

The app uses Node, Express, and Node's built-in `node:sqlite` module.

Reasoning:

- The existing Smithers Studio codebase used Node/Express patterns.
- Node 22 is the current target runtime.
- SQLite fits the private self-hosted product and local disk backup model.
- Avoiding extra database services keeps installation and backup simple.

Tradeoff:

- `node:sqlite` is still marked experimental in the Node runtime, so test output includes an experimental warning.
- This is acceptable for the current private deployment, but a future hardening pass may move to a stable SQLite package or Postgres.

### Decision: Local disk artifacts

New artifacts are written under `data/artifacts/runs/<workflow-slug>/<YYYY-MM-DD>/<run-id>/`.

Reasoning:

- The user requested local disk for v1.
- Private deployments can be backed up by copying `data/`.
- It keeps runner upload and artifact download simple.

## Authentication and Sessions

### Decision: Access-token auth only

All surfaces use Hub-issued access tokens.

Reasoning:

- The user requested access tokens issued by anyone with machine access.
- Passkeys, OAuth, and username/password are unnecessary for private self-hosted installs.

Token consumers:

- Web login
- API
- CLI
- MCP
- Runner

### Decision: Long-lived browser session cookie after token login

The Web Hub accepts an access token once and stores a signed long-lived session cookie.

Reasoning:

- The user said long-lived browser sessions are fine.
- It avoids re-entering tokens during normal human supervision.

### Decision: Bootstrap token file

On first start, the Hub creates `data/bootstrap-token.txt` if no access tokens exist.

Reasoning:

- Machine access is the admin boundary.
- The first operator can read the token locally and create additional tokens from the Web or CLI.

## Core Data Model

### Decision: Capability is the public contract

Agents should consume capabilities, not workflows directly.

Reasoning:

- Capabilities expose clear names, descriptions, input schemas, output schemas, keywords, skills, agents, runner tags, and approval policy.
- Workflows are implementation details that can change without breaking agent discovery.

### Decision: Skills, agents, and knowledge are first-class editable records

The Hub stores skills, agents, and knowledge resources in SQLite and exposes editable Web/API surfaces.

Reasoning:

- The user explicitly wants company-created skills, agents, and knowledge centralized in the Hub.
- Editing from the Hub is more productized than requiring users to edit manifest files.

### Decision: Seed capabilities ship with the product

Seeded capabilities:

- Review Pull Request
- Research Topic
- Prepare Spec
- Implement
- Run Smithers Workflow

Reasoning:

- These match the requested first capability set.
- They provide immediate agent-facing value after deployment.
- They are editable, so a company can adapt them to its own workflows.

## Execution Model

### Decision: Polling runners

Runners register and poll for matching queued runs.

Reasoning:

- Polling works for VPS and local machines without inbound network access to laptops.
- It is simpler and more reliable than websockets for the first production deployment.
- It fits private networks and machines behind NAT.

### Decision: Runner tags route work

Capabilities declare required runner tags, and runners advertise available tags.

Reasoning:

- This gives agents visibility into where a capability can run.
- It avoids overbuilding a full scheduler or permission engine.
- It keeps the future path open for stricter dispatch.

### Decision: Runners should be separate from the serving box when capacity grows

Single-machine installs may run a runner beside the Hub, but production runner capacity should live on worker machines.

Reasoning:

- The Hub server is lightweight and should remain responsive.
- Agent/build/browser work can consume CPU, memory, disk, and network.
- Keeping workers separate makes queue capacity visible and safer to tune.

### Decision: Runner pool capacity is advertised per-runner; the queue stays centralized

Each runner advertises a `capacity` (concurrent-slot count) via register + heartbeat, and the Hub honours it on `/next-run`. Single-runner deployments default to `capacity=1` (no behavior change). A dedicated VPS pool host can set `SMITHERS_RUNNER_CONCURRENCY=4` to drain backlog faster without overloading the box.

Reasoning:

- The Hub remains the single queue. Runners don't make scheduling decisions; they just advertise free slots.
- One process with N slots beats N runner processes for a small VPS: less memory overhead, one heartbeat to inspect.
- Saturated runners get visibly flagged in the Web Hub (capacity badge + slot row) and queued runs render a position chip ("In queue · #3 of 7") so operators can see backlog at a glance.

Caveat:

- The systemd unit shipped in `deploy/` is a generic template. Operators should adapt paths, env files, runner tags, and capacity for their own host layout.

### Decision: Built-in workflow adapters for seed capabilities

Seed capabilities use built-in workflow handlers that create useful durable artifacts.

Reasoning:

- The Hub needs a complete run/artifact/approval loop immediately.
- The Smithers workflow integration point remains present through `Run Smithers Workflow`.
- More concrete Smithers examples can be imported later without changing Hub concepts.

Tradeoff:

- The current built-ins are conservative orchestration scaffolds, not full autonomous code-review/research agents.
- This avoids pretending to have unavailable provider credentials or uncontrolled integrations.

## Approvals

### Decision: Approvals are centralized Hub objects

Workflows request approvals from the Hub. Approval decisions are resolved against Hub records.

Reasoning:

- The user explicitly wanted shared approval channels instead of custom per-workflow approval logic.
- It lets Web, API, CLI, MCP, and Telegram all act on the same approval.

### Decision: `Implement` requires approval by default

Capabilities that need human checkpoints are marked in their approval policy, but workflow starts do not block by default. Workflows should ask for approval only at the specific in-workflow decision point that needs it.

Reasoning:

- Implementation may modify repositories or run commands.
- The user described permissive/yolo execution as useful, but deferring the safety model means dangerous capabilities should visibly request approval.

### Decision: Telegram approvals prefer private DMs

The Hub supports Telegram approval notifications and callback resolution. Approval notifications prefer a private operator chat via `TELEGRAM_APPROVAL_CHAT_ID`; the older group/topic `TELEGRAM_CHAT_ID` and `TELEGRAM_THREAD_ID` configuration remains a fallback when a private approval chat is not configured.

Reasoning:

- The user said there was already a Smithers approval bot and a prototype miniapp.
- Approvals may contain operational context and should not be broadcast to the group by default.
- The Hub's approval model remains channel-agnostic, so Telegram does not become the approval source of truth.

## Agent Interfaces

### Decision: MCP is optimized as a capability menu

The MCP server exposes:

- `get_menu`
- `list_capabilities`
- `search_capabilities`
- `describe_capability`
- `run_capability`
- `get_run_status`
- `get_run_logs`
- `get_run_artifacts`
- `list_pending_approvals`
- `approve_run`
- `reject_run`
- `cancel_run`
- `search_artifacts`
- `list_agents`
- `list_skills`
- `search_knowledge`

Reasoning:

- The user said the main consumers are agents and the MCP + CLI combination must be strong.
- Tool names are purpose-level, not table-level.
- `get_menu` gives agents a clear first move before they choose local or remote execution.

### Decision: Local/remote execution intent is recorded on the run

CLI and MCP clients can pass `local` or `remote` execution intent. The Hub stores that intent in the run input envelope, exposes it as `run.execution`, and runner claiming honors the requested runner-location tag. `remote` targets runners tagged `vps` or `remote`; `local` targets runners tagged `local`.

Reasoning:

- The Hub remains the source of truth while execution can happen on a laptop or a VPS.
- The existing schema already allows metadata in the run input envelope, so this avoids a risky migration before the CLI/MCP test.
- Runner tags are already the routing primitive; location intent is a small extension of that model.

### Decision: Improve can target allowlisted runner-local repos

The Improve workflow accepts `repoDir` as an absolute runner-local git repo path. Runners may also expose friendly `repo` or `project` keys through JSON env maps. The selected repo controls the PM cwd, builder cwd, baseline, tests, commit, push, and deploy; the Hub remains the source of truth for logs, outputs, and artifacts.

Reasoning:

- Improve should not be tied to the Runyard/Hub repo when the operator wants to improve another project.
- Repository paths are execution authority, so runners enforce an allowlist rooted at the default repo plus `IMPROVE_ALLOWED_REPO_ROOTS`.
- Keeping logs and artifacts in the Hub preserves the product's control-plane model even when edits happen elsewhere on the runner.

### Decision: CLI mirrors operational concepts

The CLI supports login, menu discovery, run control, local/remote execution intent, logs, artifacts, approvals, token creation, runner registration/start, and MCP install config.

Reasoning:

- The CLI should be useful for humans and local agents.
- It should work in scripts and local terminals without opening the Web Hub.

### Decision: `/llms.txt` and `/openapi.json`

The Hub exposes both human-readable agent discovery and machine-readable API shape.

Reasoning:

- Agents need a stable discovery surface.
- Existing Springfield had similar discovery patterns worth reusing conceptually.

## Web Product

### Decision: Defer TanStack DB / Smithers Gateway React migration

The app remains Express plus vanilla JS for this pass, with React limited to the vendored ReactFlow workflow graph. Smithers `0.24.2`, `@smithers-orchestrator/gateway-react`, and TanStack DB are promising for a future normalized client data layer, but adopting them now would mean introducing a second frontend architecture in the middle of the CLI/MCP parity work.

Migration plan:

- First define stable Hub resources for runs, events, artifacts, runners, approvals, and capabilities.
- Add a small React island only where session/run data extraction is painful, backed by `@smithers-orchestrator/gateway-react` if it can read the same Gateway contracts.
- Use TanStack DB collections for runs, events, artifacts, and runners after the REST shapes are stable; keep Web/API/CLI/MCP responses backward-compatible.
- Replace ad hoc vanilla client joins incrementally, starting with run detail and queue/pool views.

Reasoning:

- TanStack DB is useful once the UI needs a reactive local data graph, but the immediate test path is API/CLI/MCP behavior.
- The current console is not a React app; a wholesale rewrite would be higher risk than the requested compatibility work.

### Decision: Web Hub is an operations console

The Web UI includes:

- Landing page
- Docs page
- Token login
- Dashboard
- Capability catalog/editor
- Run dashboard/detail
- Artifact browser
- Approval inbox
- Runner dashboard
- Agent editor
- Skill editor
- Knowledge editor
- Access token creation
- Settings

Reasoning:

- Humans supervise work and edit shared company context.
- The UI should be dense and operational, not a marketing-only landing page.

### Decision: Workflow detail uses tabs (Overview / Visual graph / Code / Runs)

The workflow detail page is organized into four explicit tabs surfaced as a deep-linkable sub-nav (`#workflows/<slug>/<tab>`):

- **Overview** — description, required agents/skills/runner tags, approval policy, deep link, latest runs preview.
- **Visual graph** — a ReactFlow canvas (pan, wheel zoom, fit/reset controls, minimap) over a graph derived server-side from the workflow source. A static SVG fallback renders only when the vendored ReactFlow bundle can't load.
- **Code** — a syntax-highlighted (highlight.js) viewer for the workflow source with virtual sub-tabs Code / Agents / workflowGraph and a copy-source action. Read-only.
- **Runs** — the recent runs list for this workflow with a "Run this workflow" entry point.

Reasoning:

- Springfield demonstrated that a code-aware visual canvas plus a readable code view dramatically improves the operator's grasp of a workflow.
- Smithers source remains the source of truth; the canvas and code view are renderers, not an independent semantic layer.
- ReactFlow handles pan/zoom/handles/fitView so we don't reinvent canvas plumbing.

### Decision: Workflow source endpoint at `/api/capabilities/<slug>/source`

The Web Hub and any MCP/CLI client can pull the workflow's actual source file plus a derived `graph` payload. The endpoint reads files only from `workflow-templates/workflows/` and resolves the candidate filename from `capability.workflow.entry` and `<slug>.tsx`. Path traversal is blocked at resolution time.

The response includes:

- `code`, `path`, `language`, `sizeBytes`
- `metadata` — parsed from leading `// smithers-*` header comments.
- `sections` — virtual slices for `code`, `agents`, `workflowGraph`.
- `graph` — `{ nodes, edges, sideNodes, metadata }` first-pass parsed from the JSX (Sequence/Parallel containers, Task ids/agent attributes, kind heuristics for entry/approval/test/commit/push/build/deploy/verify/task).

Reasoning:

- The visual graph and code viewer both need the same authoritative payload; one endpoint avoids drift.
- A first-pass parser keeps the implementation small while leaving an obvious extension point: when the orchestrator exposes a real `workflowGraph` description, the server can swap in that instead of regex-derived structure.

### Decision: ReactFlow and highlight.js are vendored under `public/vendor/`

The browser console loads ReactFlow + React + ReactDOM and highlight.js from same-origin ES module bundles. The bundles are produced by `pnpm run build:vendor` (`bin/build-vendor.mjs` — uses esbuild) and committed alongside the matching stylesheets and a `manifest.json`.

Reasoning:

- The Hub is private and self-hosted; loading external CDNs at runtime would weaken that posture.
- Bundling once keeps the existing CSP (`script-src 'self'`) intact and the static Express server unchanged.
- Re-run `pnpm run build:vendor` after upgrading any of those upstream packages.

### Decision: Landing page and docs are public, console requires token

Reasoning:

- The deployed product should have a marketable front door.
- Sensitive operational data remains behind token auth.

## Security Posture

### Decision: Product records permissions but does not enforce a sandbox yet

Reasoning:

- The user explicitly said useful agent workflows generally need yolo mode and to defer sandbox restrictions.
- The schema still records required runner tags, skills, agents, and approval policy.

Future hardening:

- Token scopes enforcement
- Capability-level allowlists
- Runner-level command policies
- Secrets vault integration
- More detailed audit logs

### Decision: Secrets are not committed

Production secrets live in a deployment-specific env file such as `/etc/runyard/runyard.env`, excluded from source sync.

Reasoning:

- Tokens and Telegram credentials must not be committed.
- The repo remains reusable for another private deployment.

## Known Follow-Up Decisions

These were intentionally left as future decisions:

- Whether to replace built-in workflow adapters with direct Smithers example imports.
- Whether to use Postgres for larger deployments.
- Whether to add S3-compatible artifact storage.
- Whether to enforce strict token scopes.
- Whether to add GitHub comment writeback for PR review.
- Whether to integrate the older Telegram miniapp as the main approval detail view.
