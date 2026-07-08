# Runyard

**Self-hosted control plane for agent runs.**

Runyard (package: `runyard`) is a workflow operating system you run on a box you own. Agents discover team-defined workflows over MCP/CLI/HTTP/Web, runners execute them on a VPS or laptop, and the Hub keeps the durable record of logs, events, artifacts, approvals, skills, agents, and knowledge.

One private deployment per company/org — no SaaS dependency, no shared database. The CLI and bins are `runyard`, `runyard-mcp`, and `runyard-runner`. Runyard was formerly called Smithers Hub; the legacy `SMITHERS_HUB_*` env vars are still read as fallbacks, so existing deployments and tokens carry over.

## Concepts

- **Workflow** — a public, named action agents and operators discover and run.
- **Run** — one durable execution: `queued → running → succeeded/failed/cancelled`, pausing in `waiting_approval` for human sign-off. Keeps logs, events, outputs, artifacts, and a unified timeline.
- **Runner** — a disposable process on a VPS or laptop that polls the Hub, claims matching runs, executes them, and uploads artifacts.
- **Approval** — a human checkpoint resolved from Web, API, CLI, MCP, or Telegram and recorded once.
- **Schedule** — a recurring cron (or one-shot `runAt`) timer that fires a workflow run on a cadence, managed over Web/API/MCP.
- **Artifact / Agent / Skill / Knowledge** — persistent run outputs, reusable roles, reusable tooling packages, and shared company context.
- **Access token** — the single bearer auth primitive for Web/API/CLI/MCP/runners; scopes (`api`, `mcp`, `runner`, `admin`) narrow what a token can do.

The full concepts overview, setup, API, and the in-app **Assistant** (the context-aware support copilot in `/app`) are documented in **[/docs/quickstart](public/docs.html)**.

## Retired Supervisor

The old `run-smithers` supervising wrapper has been removed from the active
product. Normal workflows run directly; the Hub and runner own status,
liveness, approvals, diagnostics, and operator recovery without inserting a
second workflow around every run.

Historical database columns remain inert so old records can still be read, but
there is no active `run-smithers` workflow, watcher workflow, default wrapper,
repair loop, or separate supervisor runner pool.

## Workflow hardening

Runyard workflows are meant to harden over time. Early runs can be agentic: agents explore the repo, write shell snippets, try commands, and discover what works. Runyard should capture that knowledge, split it into smaller deliverable steps, and progressively replace repeatable agent work with scripts, tested code, and automated machine steps.

The gradient is:

```text
agentic -> constrained agentic -> script-backed -> deterministic code -> automated machine step
```

Nightly optimizer runs should replay workflows, diff outputs, measure variance/failure/cost, delete unnecessary steps, and propose hardened replacements. Creative and taste-heavy steps may remain agentic; engineering plumbing should become deterministic wherever possible.

Before shipping or deploying a workflow, review its side effects and replayability. Steps that push, merge, deploy, publish, post externally, write production data, or otherwise mutate shared state must not be blindly replayed from checkpoints; isolate agent work, preflight dangerous config early, and make finalization/promotion a separately retryable operation when possible.

See `specs/workflow-hardening-and-optimizer.md`.

## Get started

```bash
pnpm install
```

Then read **[/docs/quickstart](public/docs.html)** (or visit `/docs/quickstart` on any running Hub) for install, run, topology, CLI, MCP, runner pool, security, env vars, and verification. The landing page (`/`) walks you through your first workflow run before you pick a topology or install channel.

After a run starts, use the Hub detail page or the CLI:

```bash
runyard tail <run-id> --once
runyard tail <run-id>
```

The tail command streams the unified run timeline as NDJSON: lifecycle status transitions, run events, runner artifacts, retrospectives, and obstruction-analysis artifacts in timestamp order.

## Improve target repos

The `improve` workflow edits the runner's configured default repo by default. To improve another repo, add it to the runner's repo policy config (`runner.config.json` by default), then pass `repoDir` as an absolute runner-local git repo path or pass a friendly `repo`/`project` key from that config.

The selected repo is where the PM review, builder, tests, commit, push, and deploy run. The Hub remains the source of truth for run status, logs, outputs, and artifacts.

## Run-creation negotiation (preflight + drafts)

Invalid or underspecified run requests should not become failed runs. Before
enqueueing, RunYard can run a deterministic preflight — required input-schema
fields, title recommendation, workflow enabled, runner tags registered/online,
obvious repo/repoDir checks, required secrets stored, hook eligibility, and
workflow source (entry/bundle) — and answer `ready`, `needs_input`, or
`blocked` with questions, blockers, warnings, and suggested defaults.

- `POST /api/workflows/{id}/preflight` (CLI: `runyard preflight <workflow>`,
  MCP: `preflight_workflow`) — stateless dry-run; nothing is created.
- `POST /api/workflows/{id}/run` with `negotiate: true` (CLI:
  `runyard run --negotiate`) — enqueues only when preflight is ready; otherwise
  returns `422` (needs_input) or `409` (blocked) with the negotiation state and
  a saved draft instead of creating a doomed run.
- Run drafts: `POST /api/run-drafts` creates and preflights a draft,
  `PATCH /api/run-drafts/{id}` merges answers into the input and re-preflights,
  `POST /api/run-drafts/{id}/submit` enqueues the real run once green, and
  `POST /api/run-drafts/{id}/discard` abandons the negotiation.

Plain `POST /api/workflows/{id}/run` without `negotiate` is unchanged for
existing clients. The preflight is deterministic — no agent, no supervisor.

## Workflow package files

Admins can share a workflow without links by exporting it as a
portable `.runyard-workflow.json` file:

```bash
runyard workflow-package export hello -o hello.runyard-workflow.json
runyard workflow-package validate hello.runyard-workflow.json
runyard workflow-package preview hello.runyard-workflow.json --slug hello-cvm
runyard workflow-package import hello.runyard-workflow.json --slug hello-cvm
```

The package contains workflow metadata, source bytes, requirements,
and content/source hashes. It never includes secret values. Import publishes the
source into the target Hub's DB-backed workflow bundle store and creates the
workflow disabled by default, so the target deployment can configure secrets,
runners, hooks, and local preflight before enabling it.

## Schedules (cron + one-shot)

Schedules fire workflows on a recurring 5-field cron cadence (with IANA
timezone support) or once at an ISO `runAt` timestamp. The full lifecycle is
exposed over HTTP (`GET/POST /api/schedules`, `GET /api/schedules/preview`,
`GET/PATCH/DELETE /api/schedules/{id}`, `POST .../enable|disable|run-now`),
over MCP (`list_schedules`, `get_schedule`, `preview_schedule`,
`create_schedule`, `update_schedule`, `enable_schedule`, `disable_schedule`,
`delete_schedule`, `run_schedule_now`), and in the web app. Each fire creates
a normal run with `origin.type "schedule"` and a `run.scheduled` event, and
the schedule row records its last run id and status. The scheduler claims due
schedules atomically, so concurrent ticks and restarts cannot double-fire.

## Agent-created run titles

When an agent starts a run, it should include `input.title` when practical:
a short, human-readable title for the specific job. This is advisory, not a
hard API requirement, but it makes run lists, approval cards, Telegram
notifications, and later handoff much easier to scan.

## Repo layout

- `bin/` — CLI / MCP / runner entry points
- `src/` — server, CLI, MCP, runner, db, security
- `public/` — landing, docs, console
- `specs/` — product intent, decisions, acceptance checks
- `workflow-templates/` — bundled Smithers workflows
- `tests/` — Node test runner

## Specs

The durable product/spec record lives in `specs/`:

- `specs/product-intent-and-user-expectations.md`
- `specs/implementation-decisions.md`
- `specs/acceptance-and-manual-tests.md`
- `specs/workflow-hardening-and-optimizer.md`

## License

MIT. File issues and PRs against the public Runyard repo. Treat hostnames like `hub.example.com` as examples — do not hard-code private hostnames in new code or docs.
