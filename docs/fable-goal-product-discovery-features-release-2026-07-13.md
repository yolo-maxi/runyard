# Fable goal: product discovery mode for RunYard feature batch

You are Claude Fable running inside the RunYard repo at `/home/xiko/runyard`.

Use hard-task-method. This is a product discovery -> implementation -> release lane, not a narrow ticket. Work autonomously, but keep scope sane and shippable.

## Current context

RunYard has recently shipped:

- `v0.5.0`: grouped workflow-first API taxonomy, `/api/v1/...` aliases, scoped tokens, read-only preset, collapsible scope picker.
- `v0.6.0`: first-class streamed run usage/cost metering, budgets, terminal usage payloads, delegated adapter usage result, metering gateway pieces.
- `v0.7.0`: first-class paused/resumable runs for credits/quota/recoverable interruptions.

Product direction from Fran:

- RunYard should be workflow-first; `capabilities` are deprecated legacy language.
- Cost/usage, budgets, paused workflows, scoped tokens, API/MCP/CLI parity, and admin-configured side effects are core product primitives.
- RunYard should be useful as a real external execution layer, not only an internal dashboard.
- The right output is not just code. Product judgment matters: find missing, confusing, overexposed, duplicated, or under-instrumented surfaces and fix a few of them.

## Mission

Run in product discovery mode:

1. Inspect the current product surface:
   - app navigation and core workflows
   - run detail/timeline/status/usage/pause/budget surfaces
   - token/scopes and Connect flows
   - API/OpenAPI/MCP/CLI surfaces
   - docs/llms guidance for external agents
   - recent specs/docs in `docs/`, `specs/`, and tests
2. Identify 5-8 plausible high-leverage features or product fixes.
3. Choose a coherent batch of 2-4 features that can realistically ship in this run.
4. Implement the chosen batch end-to-end.
5. Document the features discovered, chosen, and deferred in a concise product note.
6. Push to `origin/main` and cut a GitHub release if, and only if, verification is clean.

Favor features that make RunYard more credible as a metered, resumable, external execution layer. Good candidates may include, but are not limited to:

- Better budget/usage productization: budget presets, projected cost, clearer run-list chips, budget-stop recovery path.
- Pause/resume ergonomics: paused run queues, resume required-action callouts, API/MCP/CLI parity, operator triage filters.
- External client readiness: clearer Connect onboarding, token scope explanations, read-only vs execution presets, copy-paste examples.
- Run observability: timeline filters, usage event grouping, terminal result summaries, artifact/result affordances.
- Operational safeguards: per-token or per-workflow limits, clearer audit events, admin alerts for budget/credit/quota patterns.
- Developer/API polish: SDK-like examples, missing OpenAPI fields, MCP parity gaps, CLI commands for new primitives.

Avoid:

- Reintroducing generic `run-smithers` supervision.
- Re-expanding deprecated `capabilities` as a primary concept.
- Big redesigns without tests.
- Pure docs-only work unless discovery proves implementation would be irresponsible.
- Deploying or publishing over unrelated projects.

## Required implementation qualities

- Keep changes scoped and idiomatic to the existing repo.
- Prefer one coherent product batch over many half-finished ideas.
- Add focused tests for every shipped feature.
- Update docs/OpenAPI/MCP/CLI/UI as appropriate for the chosen features.
- Preserve backward compatibility for existing API clients where possible.
- Do not expose secrets, raw runner paths, or private env values in UI/docs/test fixtures.
- If a feature needs a product decision you cannot safely infer, defer it in the product note instead of blocking the whole lane.

## Product note

Create or update a concise note under `docs/` or `specs/`, for example:

`docs/product-discovery-2026-07-13.md`

It should include:

- features considered
- features selected for this batch
- why those were selected
- features deferred and why
- verification evidence
- any follow-up recommendation for Fran

No tables. Use bullets.

## Verification gates

Run and keep fixing until clean, unless a real external blocker is documented:

- `pnpm test`
- `pnpm build`
- `pnpm build:docs` if docs app/build exists or relevant docs changed
- targeted tests for any changed API/MCP/CLI/UI surfaces
- `git diff --check`
- `node --check` on changed JS entrypoints where applicable
- OpenAPI generation/checks if the repo has an existing command/test for it
- browser/screenshot smoke if significant UI changed
- live/scratch API smoke only after local tests pass and only if safe

Before release:

- Ensure git status is clean except intentional tracked changes.
- Bump version to the next appropriate semver version after `v0.7.0`.
- Push commits and tags to GitHub.
- Create a GitHub release summarizing the shipped feature batch.
- If the repo has deployment/release scripts or CI checks, use the established local pattern. Do not build on repo.box.

## Final report

When done, report:

- release/tag and URL
- main commits
- chosen features shipped
- deferred features
- verification results
- live/scratch smoke evidence
- any caveats

If blocked, report the exact blocker, the current branch/commit state, and the smallest next action.
