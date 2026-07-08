# Fable Goal: API Normalization, Capabilities Deprecation, and Grouped Scoped Tokens

Repo: `/home/xiko/runyard`
Date: 2026-07-08

## User Request

Fran reviewed the current API structure and said:

- Deprecate capabilities.
- Agree on rationalizing the API into groups.
- This should make scoped tokens easier too.
- Add scoped tokens to the Tokens page.
- Show collapsible scope groups and default to everything.
- Someone might want a read-only token, so make that helpful.

## Current Context

Current live release before this work: `v0.4.1`.

Recent relevant work:

- `v0.4.0` added the API-first surface registry (`src/apiSurface.js`), generated OpenAPI, extracted MCP tools, Fumadocs `/docs`, and repo-agnostic docs-update workflow.
- `v0.4.1` fixed DB workflow bundle materialization so relative imports resolve.
- Current API has 85 OpenAPI paths and 85 MCP tools.
- Current token scopes are coarse (`admin`, `api`, `mcp`, `runner`, `approvals`), with `admin` as a superscope in auth middleware.
- `/api/capabilities/*` is currently a legacy alias family for `/api/workflows/*`.

## Desired Direction

Do not break existing clients. Add rationalized aliases and documentation first, then make legacy names clearly deprecated.

Preferred future taxonomy:

- `/api/v1/workflows/*` — define, inspect, preflight, run
- `/api/v1/runs/*` — observe/control executions
- `/api/v1/approvals/*` — human decisions
- `/api/v1/automation/schedules/*`
- `/api/v1/automation/endpoints/*`
- `/api/v1/library/agents|skills|knowledge|hooks/*`
- `/api/v1/distribution/bundles|packages/*`
- `/api/v1/admin/tokens|secrets|audit|alerts|updates/*`
- `/api/v1/system/runners|health|version|menu/*`

Use judgment: if implementing every alias is too large, implement the canonical grouped skeleton and docs/tests for the most important groups, then leave a precise follow-up list.

## Part 1: Deprecate Capabilities

Make `workflows` the clear canonical language everywhere.

Requirements:

- Mark `/api/capabilities/*` as deprecated in OpenAPI and discovery docs if not already.
- Remove or hide capabilities language from current docs, `llms.txt`, menu copy, UI, and MCP descriptions except when explicitly describing legacy aliases.
- Ensure MCP exposes workflow tools as canonical. Legacy capability tool names may remain dispatch aliases for compatibility, but should not be recommended.
- Add tests that prevent new user-facing "capability" wording from reappearing in non-archive docs/discovery/UI except in allowed legacy contexts.

## Part 2: Rationalized Grouped API Surface

Add a grouped API taxonomy in the route registry and docs.

Implementation goals:

- Extend `src/apiSurface.js` entries with stable group metadata: e.g. `group`, `resource`, `operation`, and possibly `audience`.
- Generate OpenAPI tags from those groups.
- Update `/docs` API guide and `llms.txt` to present the grouped taxonomy.
- Add `/api/v1/...` grouped aliases where useful and safe, preserving existing `/api/...` paths.
- Avoid duplicate implementation; aliases should share the same registry/handler definitions.
- Make the grouped model feed future token scope grouping.

Test requirements:

- API registry tests prove grouped aliases map to the same handlers/scopes as canonical paths.
- OpenAPI exposes groups/tags clearly.
- Existing unversioned paths remain working.

## Part 3: Scoped Tokens Backend

Improve the scope model without breaking current tokens.

Goals:

- Keep current coarse scopes working.
- `admin` remains a superscope.
- Add clearer scope metadata/presets for UI/API/MCP consumers.
- Consider adding fine-grained read/write scopes if feasible, but do not destabilize auth. If full fine-grained enforcement is too large, implement the metadata/preset layer now and document enforcement follow-ups precisely.
- Provide a helpful "read-only" option. It should allow inspecting app state through API/MCP without mutation and without admin/runner rights.
- Preserve runner machine protocol safety.

Suggested scope/preset concepts:

- Everything: all normal human/API/MCP scopes the admin can grant, default in UI.
- Read-only: read app state over API/MCP; no create/update/delete/run/cancel/promote/secrets/token writes.
- Workflow operator: read + run/preflight/rerun/cancel where appropriate.
- Automation manager: schedules/endpoints/hooks.
- Library manager: agents/skills/knowledge.
- Admin: tokens/secrets/audit/update/admin-only.
- Runner: runner machine protocol only.
- Approvals-only: approval inbox and decisions.

Test requirements:

- Unknown scopes still rejected.
- Existing tokens with `api`, `mcp`, `admin`, `runner`, `approvals` keep working.
- Read-only token cannot mutate representative endpoints.
- Read-only token can read representative endpoints.
- Scope metadata/presets are exposed through API/MCP/docs.

## Part 4: Tokens Page UX

Update the Tokens page and Connect/token UI.

Requirements:

- Show collapsible scope groups.
- Default to everything selected for a normal token.
- Provide a clear read-only preset/button/path.
- Make it easy to see what each group grants.
- Keep runner token creation simple and safe.
- Existing token list should display grouped scopes more readably.
- Avoid overwhelming compact panels; keep text concise and fit mobile widths.

Verification:

- Frontend tests or static/render tests for default selection, read-only preset, group expand/collapse, and submitted scope payloads.
- Build and browser/screenshot check if feasible.

## Part 5: Real Test

Prepare a real external-client test, not just a smoke test.

Target:

- A small separate "shadow client" or script under tests/fixtures or scripts that consumes only live/staged `/openapi.json` and MCP/API endpoints, without importing RunYard server internals.
- It should use a scoped token, preferably read-only first, to rebuild the main app's informational dashboard:
  - menu/workflows
  - runs summary/list
  - approvals summary
  - schedules list
  - runners summary if permitted
  - docs/openapi discovery
- Then use a non-read-only scoped token to create a safe draft/preflight or schedule/run action, proving mutation scope separation.
- This should become a repeatable regression/e2e test where practical.

## Verification Gates

Loop until clean or document a real blocker:

- `git diff --check`
- `pnpm test`
- `pnpm build`
- Targeted API surface/group alias tests.
- Targeted capabilities-deprecation copy tests.
- Targeted token scope/preset backend tests.
- Targeted Tokens page UI tests.
- Targeted real external-client/shadow-client test.
- `node --check` on touched JS files where useful.
- Live checks after release/deploy:
  - `/api/version`
  - `/readyz`
  - `/app`
  - `/docs`
  - `/openapi.json`
  - representative `/api/v1/...` grouped aliases
  - token creation/read-only behavior if safe to test live.

## Release / Publish

If implementation and gates pass:

- Commit changes.
- Push `main`.
- Cut next patch/minor release after `v0.4.1`.
- Create/push tag and GitHub release using repo conventions.
- Deploy/restart `runyard.service`, `smithers-runner.service`, and `smithers-support-runner.service`.
- Verify live health and runner state.

If the scope model change is too large for one safe pass, ship the grouped API taxonomy + deprecation + UI preset metadata first, with explicit remaining scope-enforcement follow-ups.

## Reporting

When done, report:

- What changed in API taxonomy.
- What capability/capabilities deprecation means for current clients.
- Token scope/preset model and read-only behavior.
- Tokens page UX changes.
- Real test results.
- Commit/release/live verification.
- Any intentional compatibility aliases or follow-up risks.
