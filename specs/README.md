# Runyard Specs — index

Public name **Runyard**; codebase keeps the `smithers-hub` prefix for back-compat.
This folder is the durable product and architecture record. Read this page first to
learn what is **shipped**, **in-progress**, **archived**, or **aspirational**.

| Doc | Purpose | Status |
| --- | --- | --- |
| [`product-intent-and-user-expectations.md`](product-intent-and-user-expectations.md) | Product model, who it is for, and what users should expect from a run. | shipped |
| [`implementation-decisions.md`](implementation-decisions.md) | Current architecture decisions: Hub/runner split, SQLite, bearer-token auth, MCP surface. | shipped |
| [`acceptance-and-manual-tests.md`](acceptance-and-manual-tests.md) | Acceptance criteria and manual test coverage for the production deploy. | shipped |
| [`workflow-hardening-and-optimizer.md`](workflow-hardening-and-optimizer.md) | Hardening philosophy ("question, delete, simplify, accelerate, automate") and the optimizer loop. | in-progress |
| [`codex-goal-obstruction-analysis.md`](codex-goal-obstruction-analysis.md) | Codex/agent goal for terminal-run obstruction analysis; describes the artifact shape and the analyzer prompt. | aspirational |
| [`codex-goal-run-knowledge-builder.md`](codex-goal-run-knowledge-builder.md) | Codex/agent goal for turning successful runs into reusable knowledge entries. | aspirational |

**Want to know what runs in production today?** Open
[`implementation-decisions.md`](implementation-decisions.md) — every section there
describes a behaviour shipped in the current build. The two `codex-goal-*` files
are *prompts* for future agentic work and do not describe shipped behaviour.

The top-level [`SPEC.md`](../SPEC.md) is the short product contract; the files
here explain the intent behind the contract and the implementation decisions
made while building the first production deployment.

## Status tags

- **shipped** — describes current production behaviour. Safe to rely on.
- **in-progress** — partially shipped; sections may describe future state.
- **archived** — kept for history; do not rely on (moved to `archive/`).
- **aspirational** — a goal document or agent prompt, not a description of
  what is built. Read it as "where we are heading," not "what we have."
