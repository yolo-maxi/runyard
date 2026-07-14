# Product discovery — metered, resumable execution layer productization (2026-07-13)

Lane: `docs/fable-goal-product-discovery-features-release-2026-07-13.md`. Discovery ran over the
app navigation and run surfaces, the API surface registry / MCP / CLI, token & Connect flows,
docs-site + llms.txt, and the standing specs (`specs/product-surface-audit.md`,
`specs/approval-sensemaking.md`, `docs/api-v1-scopes-followups.md`). The v0.5.0–v0.7.0 lane built
strong primitives (scoped tokens, usage metering + budgets, paused runs); discovery found they
were under-productized: strong data, weak operator surfaces.

## Features considered

- Aggregate usage/cost rollups (per workflow, per window). Metering existed only per-run plus one
  fleet total buried in the dashboard payload — no way to answer "what is this deployment
  spending, on what?".
- A needs-attention/triage queue. Paused, budget-stopped, and waiting-approval runs were only
  discoverable via manual status filters; the dashboard folded `paused` into "running"; Home had
  no triage surface at all (an unwired `HomeChrome.jsx` proved the need).
- Budget legibility. Run detail showed the budget ceiling and the spend as two unrelated chips;
  the budget-stop notice carried no numbers; clients had to re-derive remaining/percent themselves.
- CLI parity for the new primitives. No `usage`, no budget flags on `run`/`preflight`, no
  `token-scopes`, no triage command — the API/MCP had all of it.
- Token-filled Connect examples. After minting, the operator got a bare token and a `$TOKEN`
  placeholder — no ready-to-paste login/curl.
- Per-token / per-workflow spend limits (cost governance above the per-run budget).
- Approval verb parity (`resolve_approval`, `POST /api/approvals/:id/resolve` — branch 6 of the
  approval-sensemaking plan) and actionable escalation options (branch 3).
- Run-status orthogonalization (status vs failure-class split) and the catalog audience model,
  both still open in the product-surface audit.

## Selected for this batch

One coherent theme — make RunYard credible as a metered, resumable, external execution layer:

- **Usage rollups**: `GET /api/usage/summary` (`?days=`, windowed totals + per-workflow breakdown
  sorted by spend + budget-stop count), MCP `get_usage_summary`, CLI `runyard usage [runId]`.
- **Needs-attention queue**: `GET /api/runs/attention` (paused / waiting-approval /
  budget-stopped-last-7-days, with counts incl. pending approval cards), MCP
  `list_attention_runs`, CLI `runyard attention`, and a Home triage strip with inline
  resume/review/inspect actions. Run lists gained paused-reason and budget chips, and
  `budget_exceeded` joined the status filter.
- **Budget legibility**: server-computed `budgetStatus` (spent vs limit, remaining, percentUsed,
  `nearLimit` at 80%) on every budgeted run payload; run detail pairs spent/limit with percent;
  the budget-stop notice states the numbers and the recovery path; `budgetStop` also rides the
  run detail payload.
- **External-client readiness**: token-filled CLI-login and curl snippets (masked, copyable)
  after minting on Connect; CLI `token-scopes`; `--max-tokens` / `--max-cost` budget flags on
  `runyard run` and `runyard preflight`; agent-consumers guide gained a metered/paused end-to-end
  walkthrough; llms.txt and the docs site describe the new endpoints.

## Why these

- They compound one story: cap a run's spend, see spend/remaining while it runs, get parked
  instead of failed when providers dry up, and find everything waiting on a human in one call.
  That story is the product direction (metered, resumable, external execution layer).
- Every piece rides the existing API surface registry, so OpenAPI/MCP/web parity came
  test-enforced rather than hand-maintained.
- All four were shippable in one lane with focused tests; none required a product decision that
  isn't already settled direction.

## Deferred, and why

- **Per-token / per-workflow spend limits** — real cost governance needs decisions (enforcement
  point, reset windows, who may override) that deserve their own design note; the per-run budget
  plus the new rollup covers the observability half today.
- **Approval branches 3 (escalation options act) and 6 (`resolve_approval` verb parity)** —
  next-best candidates, but a different theme; branch 6 is small and well-specified in
  `specs/approval-sensemaking.md` §7 and should ride the next approvals lane.
- **Run-status orthogonalization, catalog audience model, hooks executor** — larger standing
  items from the audit; each is a lane of its own.
- **Usage-over-time charts in the web app** — the summary endpoint now provides the data; a chart
  is polish once someone asks for it.
- Cleanup noticed but not done here: `web/components/HomeChrome.jsx` is dead code (zero imports);
  the audit already lists it for deletion.

## Verification evidence

- `pnpm test`: 1411 pass / 0 fail (2 skipped) after the batch; baseline before the batch was
  1394 pass / 0 fail.
- New tests: `tests/usage-summary.test.js` (window clamp, query scoping, normalizers, both new
  handlers), `tests/attention-usage-ui.test.js` (triage strip, chips, budget pairing, connect
  snippets), `runBudgetStatus` cases in `tests/run-usage.test.js`; parity suites
  (`api-surface`, `server-routes`, `discovery-docs`) updated and green — the new endpoints are
  fully registered in routes/OpenAPI/MCP by construction.
- `pnpm build` (vendor + web bundle) and `pnpm build:docs` clean; `git diff --check` clean;
  `node --check` on every touched entrypoint.
- Live scratch-hub smoke: seeded paused / budget-exceeded / metered runs, then exercised
  `/api/runs/attention`, `/api/usage/summary`, run payload `budgetStatus`, and the Home triage
  strip in the built web app.

## Follow-up recommendations for Fran

- Ship approval branch 6 (`resolve_approval` + `POST /api/approvals/:id/resolve`) next — small,
  specified, and it fixes the worst-named tools agents touch.
- Decide the shape of per-workflow/per-token spend caps (the one governance gap the rollup now
  makes visible); a short spec first, not code.
- Delete `HomeChrome.jsx` and consider a small usage panel on WorkflowDetail fed by
  `GET /api/usage/summary` — cheap now that the endpoint exists.
