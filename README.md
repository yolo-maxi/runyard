# Runyard

**Self-hosted control plane for agent runs.**

Runyard (package: `runyard`) is a capability operating system you run on a box you own. Agents discover team-defined capabilities over MCP/CLI/HTTP/Web, runners execute them on a VPS or laptop, and the Hub keeps the durable record of logs, events, artifacts, approvals, skills, agents, and knowledge.

One private deployment per company/org — no SaaS dependency, no shared database. The CLI and bins are `runyard`, `runyard-mcp`, and `runyard-runner`. Runyard was formerly called Smithers Hub; the legacy `SMITHERS_HUB_*` env vars are still read as fallbacks, so existing deployments and tokens carry over.

## Concepts

- **Capability** — a public, named action agents and operators discover and run (surfaced as *workflows* in the app/API).
- **Workflow** — the Smithers steps behind a capability.
- **Run** — one durable execution: `queued → running → succeeded/failed/cancelled`, pausing in `waiting_approval` for human sign-off. Keeps logs, events, outputs, artifacts, and a unified timeline.
- **Runner** — a disposable process on a VPS or laptop that polls the Hub, claims matching runs, executes them, and uploads artifacts.
- **Approval** — a human checkpoint resolved from Web, API, CLI, MCP, or Telegram and recorded once.
- **Artifact / Agent / Skill / Knowledge** — persistent run outputs, reusable roles, reusable tooling packages, and shared company context.
- **Access token** — the single bearer auth primitive for Web/API/CLI/MCP/runners; scopes (`api`, `mcp`, `runner`, `admin`) narrow what a token can do.

The full concepts overview, setup, API, and the in-app **Assistant** (the context-aware support copilot in `/app`) are documented in **[/docs/quickstart](public/docs.html)**.

## Retired Supervisor

The old `run-smithers` supervising wrapper is disabled. Normal workflows run
directly; the Hub and runner own status, liveness, approvals, diagnostics, and
operator recovery without inserting a second workflow around every run.

The old watcher source remains in the repository for historical runs and narrow
regression coverage, but it is not part of the active capability catalog and new
runs are not wrapped by default or by stale `supervision.default` config.

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

Then read **[/docs/quickstart](public/docs.html)** (or visit `/docs/quickstart` on any running Hub) for install, run, topology, CLI, MCP, runner pool, security, env vars, and verification. The landing page (`/`) walks you through your first capability run before you pick a topology or install channel.

After a run starts, use the Hub detail page or the CLI:

```bash
runyard tail <run-id> --once
runyard tail <run-id>
```

The tail command streams the unified run timeline as NDJSON: lifecycle status transitions, run events, runner artifacts, retrospectives, and obstruction-analysis artifacts in timestamp order.

## Improve target repos

The `improve` workflow edits the runner's default repo by default: `IMPROVE_REPO_DIR || GATED_REPO_DIR || process.cwd()`. To improve another repo, pass `repoDir` as an absolute runner-local git repo path and allow it with `IMPROVE_ALLOWED_REPO_ROOTS`, or pass a friendly `repo`/`project` key from `IMPROVE_REPO_MAP` / `IMPROVE_PROJECT_MAP`.

The selected repo is where the PM review, builder, tests, commit, push, and deploy run. The Hub remains the source of truth for run status, logs, outputs, and artifacts.

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
