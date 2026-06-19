# Runyard Spec (codebase: smithers-hub)

For the expanded decision record, user intent, expectations, and acceptance checks, see the `specs/` folder:

- `specs/product-intent-and-user-expectations.md`
- `specs/implementation-decisions.md`
- `specs/acceptance-and-manual-tests.md`

## Naming

**Runyard** is the public product name. The codebase, package, bin names, env vars, and tokens keep the `smithers-hub` prefix for backwards compatibility. Treat "Runyard" and "Smithers Hub" as synonyms in docs; prefer "Runyard" for new user-facing copy.

Tagline: **Self-hosted control plane for agent runs.**

## Summary

Runyard is a private, self-hosted company capability platform. Agents discover capabilities through MCP and CLI. Humans supervise through Web, Telegram, CLI, API, and MCP approvals. Runners execute work on the Hub VPS or local machines while the Hub stores the durable record.

## Product Objects

- Capability: public action agents can inspect and run.
- Workflow: implementation detail behind a capability.
- Run: durable execution record.
- Artifact: persistent output associated with a run.
- Approval: human checkpoint resolved through shared channels.
- Runner: registered execution environment.
- Skill: reusable instruction/tooling package.
- Agent: reusable role/profile.
- Knowledge Resource: shared company context.
- Access Token: auth primitive for Web/API/CLI/MCP/Runner.

## Required Interfaces

- Web Hub: landing page, docs, catalog, editors, runs, artifacts, approvals, runners, tokens.
- HTTP API: auth, capabilities, runs, logs, artifacts, approvals, agents, skills, knowledge, runners.
- CLI: login, capabilities, run, runs, logs, artifacts, approvals, tokens, runners.
- MCP: capability discovery, run creation/status/logs/artifacts, approvals, agents, skills, knowledge.
- Telegram: optional approval notifications and callback resolution.

## Execution Model

The Hub is the source of truth. Local runners poll for work, execute matching queued runs, stream events, upload artifacts, and mark runs complete or failed. Runs that require approval enter `waiting_approval` until approved through Web/API/CLI/MCP/Telegram.

Repository-editing workflows may select an allowlisted runner-local git repo, but the Hub remains the durable record for status, logs, outputs, approvals, and artifacts.

## Storage

SQLite and local disk are the production default for a private per-company deployment.

```txt
data/
  smithers-hub.sqlite
  bootstrap-token.txt
  artifacts/
    runs/<run-id>/
```

## Non-SaaS Model

Runyard is productized for installable private deployments. It is not multi-tenant SaaS in this version. Each company deploys its own Hub on its own domain.

## Brand System

- Public name: **Runyard**. Internal codebase / package / bin: `smithers-hub`.
- Palette: ink (`#15191f`), off-white (`#f6f5ef`), signal green (`#1f6f4a` brand / `#15803d` ok), signal amber (`#b45309`), signal red (`#b91c1c`), one blue accent (`#2563eb`).
- Status colors align with run states: green = succeeded/approved/online, amber = running/queued/waiting_approval, red = failed/error/rejected/cancelled.
- Brand mark and logotype live in `public/styles.css` as pure CSS — no external image dependency.
- Telegram-facing summaries must not render HTML tables.
