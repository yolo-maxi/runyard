# Fable Goal: API-First App Parity, Fumadocs Docs, and Release-Triggered Docs Workflow

Repo: `/home/xiko/runyard`
Date: 2026-07-08

## User Request

Fran asked for three broad RunYard improvements:

1. Full audit of the code so every button and every piece of information in the app is available through API/MCP. Any consumer should be able to make their own version of the app losslessly. This should become a feature of how RunYard writes APIs, not a thing manually tracked forever: the UI should be an API consumer with no special privileges. If the UI wants to show something, it must change the API, and that should become automatically available in MCP.
2. Write a full version of docs that lives at `/docs`. Use Fumadocs. Use Cloudflare/routing as needed to fix the docs page.
3. Create a RunYard workflow that updates docs according to new code changes by checking code diffs, not reading the full codebase, and trigger it on every new release, likely as a GitHub CI gate.

## Operating Constraints

- Build/test/run agents on the Hetzner machine only. repo.box is publish/serve-only.
- Preserve production safety. Do not expose private tokens/secrets in docs or public surfaces.
- Do not deploy source directories or sourcemaps into public web roots.
- Existing production domain: `https://runyard.repo.box`.
- `hub.repo.box` is retired historical language unless found in archived docs.
- Current release before this work: `v0.3.10`.
- Prefer DB-backed workflow bundles as the normal production/custom workflow path.
- Keep user-facing copy workflow-first and API/MCP-first.

## Part 1: API-First Product Surface Audit + Implementation

### Goal

Make the RunYard web UI structurally incapable of becoming more capable than the public API/MCP surface.

The target invariant:

> The app UI is an ordinary API client. If the UI displays data or exposes an action, that data/action is available through the HTTP API and discoverable through MCP.

### Audit Requirements

Produce an audit document under `docs/` that maps the app surface:

- Every navigation item.
- Every page/detail view.
- Every button/action/menu item.
- Every status chip/count/card/list field/detail field.
- Every modal/form/input.
- Every nontrivial computed value or piece of information shown to users.

For each item, record:

- UI file/component.
- HTTP API endpoint(s) that provide the data/action.
- MCP tool(s) that expose equivalent access.
- Whether the UI currently uses only API responses or has privileged local/server-only knowledge.
- Any gaps and the implemented fix or explicit deferral.

No tables in Telegram reports, but markdown tables are fine inside repo docs if they fit local docs style.

### Implementation Requirements

Fix every reasonable gap found.

Prefer a structural solution over one-off parity patches:

- If endpoint metadata already exists, extend it so OpenAPI, MCP, CLI/discovery, and docs can share the same source of truth.
- If route definitions are scattered, introduce or improve a route/tool descriptor layer so MCP tools can be generated or kept mechanically in sync with API operations.
- If the UI imports privileged internals, move that data/action behind an API endpoint.
- Add tests that fail when an API-exposed action is missing MCP coverage, or when a UI action uses a private/non-API path.
- Add tests that ensure discovery docs and `llms.txt` include newly exposed API/MCP affordances.

It is acceptable to keep narrowly internal/admin bootstrap/dev-only behavior out of MCP if it is not visible or actionable in the UI. Document every intentional exception.

### Acceptance Criteria

- A third-party client can rebuild the RunYard app experience through API/MCP without relying on private files, server internals, or browser-only privileged state.
- The UI has no hidden extra power over API/MCP consumers.
- Future UI/API/MCP drift is guarded by tests or shared generation.

## Part 2: Full `/docs` With Fumadocs

### Goal

Replace the current docs experience with a real Fumadocs-based documentation site mounted at `/docs`.

Docs should cover at minimum:

- What RunYard is.
- Concepts: workflows, runs, approvals, runners, schedules, agents, skills, knowledge, secrets, tokens, hooks, workflow bundles/packages, API/MCP.
- Installation and deployment shape.
- API authentication and token scopes.
- API guide.
- MCP guide.
- CLI guide.
- Workflow creation/editing/import/export using DB-backed source/bundles, not "save a workflow.tsx".
- Schedules/cron jobs.
- Runners and health.
- Approvals and Telegram.
- Release/versioning.
- Security model and operational constraints.
- Troubleshooting.
- `llms.txt` / agent-consumer guidance.

### Routing / Cloudflare Requirements

- `/docs` and nested docs routes must work live under `https://runyard.repo.box/docs`.
- Inspect the current routing stack (Hetzner service, Caddy, Cloudflare DNS/rules) and fix the docs route correctly.
- If Cloudflare configuration is required, make the smallest safe change and document it.
- Verify live HTTP behavior after deploy.
- Do not break `/app`, `/api/*`, `/mcp`, `/llms.txt`, `/openapi.json`, install scripts, or static assets.

### Fumadocs Requirements

- Use Fumadocs rather than a one-off static HTML page.
- Integrate in a way that fits the current app stack; if the current stack makes direct integration awkward, choose the smallest maintainable architecture and document it.
- Docs content should be versionable in the repo.
- The built docs output must be served by RunYard at `/docs` without needing repo.box to build anything.
- Ensure docs do not publish secrets, private local paths beyond intentional examples, or internal-only operational tokens.

## Part 3: Release-Triggered Docs Update Workflow

### Goal

Create a reusable, repo-agnostic RunYard workflow that keeps docs current from code changes.

This workflow should not be hardcoded to RunYard beyond any local wiring needed to dogfood it here. Design it as a reusable workflow template/capability that other repos can run with config such as repo path, docs path, previous/current refs, release metadata, docs framework hints, and update mode. RunYard should be the first adopter, not the only possible consumer.

Workflow behavior:

- On a release, inspect only the relevant git diff since the previous release/tag, not the full repo.
- Identify API/MCP/UI/behavior changes that should update docs.
- Propose or apply docs updates depending on the chosen safe RunYard workflow pattern.
- Include a clear report of what changed, what docs were updated, and any docs gaps requiring human review.
- Accept generic repo inputs and avoid assuming RunYard-specific paths except through configuration/defaults.
- Support repo-specific adapters or hints where needed, but keep the core diff-to-docs workflow portable.

### Triggering

- Add a GitHub CI/release integration that triggers this RunYard workflow for each new release/tag.
- Use safe token handling. Do not commit tokens. If live secrets are required, document required secret names and add graceful failure with a useful message.
- The release pipeline should not silently pass if the docs update workflow trigger failed unexpectedly.
- If docs update must be approval-gated before committing, wire that explicitly.

### Workflow Implementation

- Add the workflow as a DB-bundled/seeded RunYard workflow using the repo's current production workflow conventions.
- The workflow must avoid full-code ingestion. It should use `git diff`/changed-file summaries, OpenAPI/MCP discovery snapshots, and targeted file reads only when a diff says a doc-relevant file changed.
- Add tests covering the workflow's diff-selection behavior and trigger payload handling.
- Add tests or fixtures proving the docs-update workflow can operate on at least one non-RunYard-shaped sample repo/config, even if the first live trigger is wired for RunYard releases.

## Verification Gates

Loop until clean or document a real blocker:

- `git diff --check`
- `pnpm test`
- `pnpm build`
- targeted tests for API/MCP parity generation or guardrails
- targeted tests for UI-to-API-only invariant where feasible
- targeted tests for Fumadocs build/route integration
- targeted tests for docs-update workflow diff-only behavior
- targeted tests for GitHub release trigger payload handling
- `node --check` on touched JS files where useful
- browser/HTTP smoke for `/docs`, `/docs/*`, `/app`, `/api/version`, `/readyz`, `/llms.txt`, `/openapi.json`
- live deploy/restart checks if release is cut

## Release / Publish

After implementation and verification:

- Commit changes with a clear message.
- Push `main`.
- Bump version to the next appropriate release after `v0.3.10`.
- Create and push release tag.
- Create/update GitHub Release if the repo convention requires it.
- Deploy/restart live RunYard services:
  - `runyard.service`
  - `smithers-runner.service`
  - `smithers-support-runner.service`
- Verify live version, readiness, docs route, app route, and runner health.

If a safe complete release is too large for one pass, stop after a committed audit/report plus the first structural implementation slice, with exact remaining work. Prefer completing an end-to-end thin slice over leaving a vague audit.

## Reporting

When done, report:

- Audit document path and headline gaps/fixes.
- Structural API/MCP parity mechanism added.
- Fumadocs docs path/routes and live URL.
- Docs-update workflow slug and trigger mechanism.
- Commit hash, release tag, release URL.
- Gate results.
- Live verification.
- Any intentional exceptions or follow-up risks.
