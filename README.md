# Runyard

**Self-hosted control plane for agent runs.**

Runyard (codebase: `smithers-hub`) is a capability operating system you run on a box you own. Agents discover team-defined capabilities over MCP/CLI/HTTP/Web, runners execute them on a VPS or laptop, and the Hub keeps the durable record of logs, events, artifacts, approvals, skills, agents, and knowledge.

One private deployment per company/org — no SaaS dependency, no shared database. The package, bin names (`smithers-hub`, `smithers-hub-mcp`, `smithers-hub-runner`), and `SMITHERS_HUB_*` env vars all keep their existing prefix, so deployments and tokens carry over.

## Get started

```bash
pnpm install
```

Then read **[/docs/quickstart](public/docs.html)** (or visit `/docs/quickstart` on any running Hub) for install, run, topology, CLI, MCP, runner pool, security, env vars, and verification. The landing page (`/`) walks you through your first capability run before you pick a topology or install channel.

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

## License

MIT. File issues and PRs against the public Runyard repo. Treat hostnames like `hub.example.com` as examples — do not hard-code private hostnames in new code or docs.
