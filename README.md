# Runyard

**Self-hosted control plane for agent runs.**

Runyard (codebase: `smithers-hub`) is a capability operating system you run on a box you own. Agents discover team-defined capabilities over MCP/CLI/HTTP/Web, runners execute them on a VPS or laptop, and the Hub keeps the durable record of logs, events, artifacts, approvals, skills, agents, and knowledge.

One private deployment per company/org — no SaaS dependency, no shared database. The package, bin names (`smithers-hub`, `smithers-hub-mcp`, `smithers-hub-runner`), and `SMITHERS_HUB_*` env vars all keep their existing prefix, so deployments and tokens carry over.

## run-smithers (supervising wrapper)

`run-smithers` is the core Orchestration capability that wraps any other capability/workflow request inside a Smithers-managed supervising run. The watcher:

- Records child lineage: child run id, capability, current/failed step, checkpoint when present, recovery attempts, and normalized error fingerprint counts.
- Retries recoverable failures and re-queues child runs whose state was interrupted.
- Pauses autonomous retry and requests an approval (with concrete options: retry as-is, approve a revised input, or abandon) once the same normalized error fingerprint repeats three times.
- Never marks the supervising run a success unless the child workflow reaches a terminal `succeeded` state.

Existing user-facing workflows are migrating to run behind `run-smithers` so every long-running goal carries the same lineage and recovery semantics. The pure watcher decision logic lives in `src/runSmithersWatcher.js` and is covered by `tests/run-smithers-watcher.test.js`.

## Workflow hardening

Runyard workflows are meant to harden over time. Early runs can be agentic: agents explore the repo, write shell snippets, try commands, and discover what works. Runyard should capture that knowledge, split it into smaller deliverable steps, and progressively replace repeatable agent work with scripts, tested code, and automated machine steps.

The gradient is:

```text
agentic -> constrained agentic -> script-backed -> deterministic code -> automated machine step
```

Nightly optimizer runs should replay workflows, diff outputs, measure variance/failure/cost, delete unnecessary steps, and propose hardened replacements. Creative and taste-heavy steps may remain agentic; engineering plumbing should become deterministic wherever possible.

See `specs/workflow-hardening-and-optimizer.md`.

## Get started

```bash
pnpm install
```

Then read **[/docs/quickstart](public/docs.html)** (or visit `/docs/quickstart` on any running Hub) for install, run, topology, CLI, MCP, runner pool, security, env vars, and verification. The landing page (`/`) walks you through your first capability run before you pick a topology or install channel.

## Agents — start here

**Capabilities are the public contract.** When asked to "do X", an agent's first move should be to call the Hub MCP (`list_capabilities` / `search_capabilities`) — not to write the work by hand and not to fall back to the local `smithers` (smithers-orchestrator) MCP, which only sees workflows in the current `.smithers/workspace` and returns `[]` when none are scaffolded. To make the integration unambiguous:

```bash
smithers-hub mcp-config                           # print the JSON snippet (with footer guidance)
smithers-hub mcp install --client mcporter        # OpenClaw / mcporter (~/.mcporter/mcporter.json)
smithers-hub mcp install --client mcporter --as smithers   # override the local smithers-orchestrator MCP
smithers-hub mcp install --all                    # auto-detect every AI client on this machine
```

The Hub MCP also exposes `list_workflows` / `run_workflow` / `watch_run` as compatibility aliases that route to `list_capabilities` / `run_capability` / `get_run_status`, so a session that still calls the smithers-orchestrator tool names lands on the Hub catalog instead of an empty result.

## Improve target repos

The `improve` workflow edits the runner's default repo by default: `IMPROVE_REPO_DIR || GATED_REPO_DIR || process.cwd()`. To improve another repo, pass `repoDir` as an absolute runner-local git repo path and allow it with `IMPROVE_ALLOWED_REPO_ROOTS`, or pass a friendly `repo`/`project` key from `IMPROVE_REPO_MAP` / `IMPROVE_PROJECT_MAP`.

The selected repo is where the PM review, builder, tests, commit, push, and deploy run. The Hub remains the source of truth for run status, logs, outputs, and artifacts.

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
