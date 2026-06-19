# Implementation Decisions

This file records the implementation decisions made for the current Smithers Hub build.

## Product and Deployment Model

### Decision: Private installable product, not hosted SaaS

Smithers Hub is built as one private deployment per company.

Reasoning:

- The user wants to run separate Hubs for separate organizations.
- Each org should own its own domain, machine, tokens, runners, and data.
- Multi-org SaaS auth and billing would add complexity that does not serve the current product model.

Expectation:

- `hub.repo.box` is one company deployment.
- Another org can deploy the same repo to a different machine/domain.

### Decision: `hub.repo.box` is the production deployment

The first deployment is on the repo.box VPS, not the Hetzner primary machine.

Reasoning:

- `*.repo.box` DNS points to the repo.box VPS.
- Deploying the app on Hetzner would not serve the requested domain without extra routing.

Deployment details:

- App path: `/home/fran/smithers-hub`
- Domain: `https://hub.repo.box`
- Hub service: `smithers-hub.service`
- Runner service: `smithers-hub-runner.service`
- Caddy route: `hub.repo.box -> 127.0.0.1:43117`

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
- Node 22 was already installed on repo.box for Springfield.
- SQLite fits the private self-hosted product and local disk backup model.
- Avoiding extra database services keeps installation and backup simple.

Tradeoff:

- `node:sqlite` is still marked experimental in the Node runtime, so test output includes an experimental warning.
- This is acceptable for the current private deployment, but a future hardening pass may move to a stable SQLite package or Postgres.

### Decision: Local disk artifacts

Artifacts are written under `data/artifacts/runs/<run-id>/`.

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

### Decision: The repo.box VPS has a default runner

The deployed Hub includes `smithers-hub-runner.service`.

Reasoning:

- The product should work immediately after deployment.
- A user should be able to run seed capabilities before installing a separate local runner.

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

### Decision: CLI mirrors operational concepts

The CLI supports login, discovery, run control, logs, artifacts, approvals, token creation, runner registration/start, and MCP install config.

Reasoning:

- The CLI should be useful for humans and local agents.
- It should work in scripts and local terminals without opening the Web Hub.

### Decision: `/llms.txt` and `/openapi.json`

The Hub exposes both human-readable agent discovery and machine-readable API shape.

Reasoning:

- Agents need a stable discovery surface.
- Existing Springfield had similar discovery patterns worth reusing conceptually.

## Web Product

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

Production secrets live in `/home/fran/smithers-hub/.env`, excluded from source sync.

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
