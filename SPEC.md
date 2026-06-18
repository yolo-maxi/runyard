# Smithers Hub Spec

## Summary

Smithers Hub is a private, self-hosted company capability platform. Agents discover capabilities through MCP and CLI. Humans supervise through Web, Telegram, CLI, API, and MCP approvals. Runners execute work on the Hub VPS or local machines while the Hub stores the durable record.

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

Smithers Hub is productized for installable private deployments. It is not multi-tenant SaaS in this version. Each company deploys its own Hub on its own domain.

