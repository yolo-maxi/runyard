# Post-run hooks

Status: first vertical slice (model, config surface, API/CLI/MCP readiness,
terminology migration). Runner-side profile execution is a documented
follow-up.

## Why

The old `deploy: true` input on product workflows implied RunYard magically
knows the operator's infrastructure. It doesn't, and it shouldn't guess. The
product decision this note records:

- Core runs produce **verified artifacts and outputs** by default.
- Any side effect after a run — static publish, Vercel preview, git push,
  webhook callback, custom script — is an explicit, opt-in **post-run hook**
  invocation, never implicit workflow magic.
- Hooks are **admin-configured and admin-gated**, like workflows and
  capabilities. A normal caller can only *select* from enabled, allowed hook
  profiles, and only when the capability permits it.
- A failed hook never rewrites a green build into a failed run. Hook outcomes
  have their own vocabulary: `hook_failed`, `hook_config_required`,
  `hook_blocked` (plus `succeeded` / `skipped`).

## Model

A **hook profile** is an admin-authored row in the new `hook_profiles` table
(`src/dbSchema.js`), validated by `src/hookProfileRecords.js`:

- `slug`, `name`, `description`, `enabled`, `version` (bumped on definition
  hash change, like capabilities).
- `kind` — one of `static-publish`, `git-push`, `webhook`, `vercel-preview`,
  `custom-script`. Fixed set; each kind has a fixed config-key contract and
  unknown config keys are rejected, so raw credentials or ad-hoc knobs cannot
  be smuggled into a profile.
- `config` — bounded per-kind JSON (16 KB cap). Paths must be absolute;
  webhook URLs must be https with no embedded credentials; git remotes are
  names, never URLs.
- `params` — declared caller-facing parameters (name/type/description), the
  only dynamic values a caller can pass to a hook.
- `secretNames` — secrets referenced **by name only**, resolved from the
  encrypted secrets store at execution time. Values never appear in the API,
  MCP, CLI, logs, events, audit entries, or artifacts.
- `allowedCapabilities` — which capabilities may invoke this profile
  (empty = any capability that opts in on its side).

### Two-sided permission

Selection is default-closed on both sides:

1. The capability opts in via `workflow.hooks.allowedProfiles` (rides in the
   capability's workflow JSON like `adminOnly`; `"*"` allows any profile the
   profile side permits). Today only `idea-to-product` opts in, to
   `["static-publish"]`.
2. The admin-authored profile must exist, be enabled, and allow the
   capability.

`POST /api/capabilities/:id/run` rejects `input.postRunHooks` entries that
fail this intersection with `400 hook_blocked` before a run is created.

### Promotion safety

`git-push` profiles may only target work branches: validation rejects
`targetBranch`/`branchPrefix` values that hit protected branches
(`main`/`master`). Merge-to-main stays behind the existing explicit
run-promotion gate (`POST /api/runs/:id/promote`). Git push as a hook is a
*conceptual* profile in this slice — the executor is follow-up work — but the
schema-level guard exists and is tested now so it cannot be configured
unsafely later.

### custom-script is conservative

Admin-defined absolute `command` plus an execFile-style `argv` array. No
shell is ever involved; dynamic argv entries may only reference declared
params (`{param}`) or fixed run fields (`{field: artifactPath|runId|runUrl}`).
No user-supplied shell fragments, ever.

## Surfaces

- **API** (`src/hookProfileRoutes.js`, registered in `src/serverRoutes.js`):
  - `GET /api/hooks` — authenticated discovery. Non-admins see enabled
    profiles in a caller-safe shape (slug/name/description/kind/params);
    config, secret names, and infrastructure details are admin-only.
    `?capability=<slug>` filters to eligible profiles; `?all=1` (admin)
    includes disabled ones with readiness.
  - `GET /api/hooks/:slug` — describe (admin sees config + readiness;
    disabled profiles 404 for non-admins).
  - `POST /api/hooks`, `PATCH /api/hooks/:slug` — admin-only upsert with
    validation; invalid definitions never persist; audit records slug only.
  - `POST /api/hooks/:slug/validate` — admin-only readiness dry-run; reports
    `hook_config_required` with **missing secret names only**.
- **CLI** (`src/cli.js`): `runyard hooks [--capability <slug>] [--all]`,
  `runyard hook describe <slug>`, `runyard hook validate <slug>`.
- **MCP** (`src/mcp.js`): `list_hooks` tool (optionally by capability).
- **Discovery** (`src/discoveryDocs.js`): menu tools list, `/llms.txt`
  section, OpenAPI paths.

## Run outcome representation

`src/hookOutcomes.js` defines the status vocabulary and
`collectHookOutcomes(output)`, which reads the workflow's `hooks` output node
({status, results[]}) — or a hook-style status on a legacy `deploy` node —
and returns `null` for runs that predate hooks. `runOutcomeSummary`
(`src/runOutcomePresentation.js`) now carries a `hooks` field alongside
`classification`; the run's own status is never derived from hook results.

## Workflow migration (deploy → postRunHooks)

- **idea-to-product**: input gains `postRunHooks: string[]` (default `[]` —
  build + verify only). The old `deploy` task is now a `hooks` task that
  executes the `static-publish` hook when explicitly requested, reporting
  per-hook statuses and **never throwing**: missing REPOBOX/STATIC_SITE env →
  `hook_config_required`; occupied live slot without `replaceLive` →
  `hook_blocked`; publish/verification failure → `hook_failed`; otherwise
  `succeeded` with URL/magic link. Legacy `deploy: true` no longer publishes —
  it reports `hook_config_required` with a pointer to `postRunHooks`.
  `publicAccess`/`replaceLive` remain as static-publish hook params. The
  live-app guard task is skipped unless static-publish is requested.
- **implement-change-gated / improve**: the run is complete once the branch
  is pushed. The inline GATED_PROD_* SSH deploy path is removed; the final
  task is a `hooks` reporting node. Legacy `deploy: true` is a no-op reported
  as `hook_config_required` (the old code *threw* at preflight when deploy
  config was missing — that could fail an otherwise-green run and is exactly
  the failure-mode this feature removes).
- **product-workflow**: no longer forwards `deploy` to child runs.
- Seeds in `src/seedCapabilityProduct.js` updated in lockstep (input/output
  schemas, descriptions, keywords, approval reasons). `deploy` is no longer
  advertised anywhere; where accepted, it is a deprecated alias that resolves
  to `hook_config_required`.

## Behavior changes an operator will notice

1. `idea-to-product` no longer publishes by default (`deploy` used to default
   to `true`). Publishing requires `postRunHooks: ["static-publish"]` AND an
   admin-enabled `static-publish` hook profile allowing the capability.
2. `improve` / `implement-change-gated` with `deploy: true` no longer SSH to
   GATED_PROD_* and restart the hub. The push still happens; the deploy
   becomes an explicit follow-up (promotion + operator deploy, or a future
   hook executor).
3. A run whose only problem is a hook now completes with its build status
   intact and `hooks.status` describing the side-effect problem.

## Implemented in this slice

- `hook_profiles` table, records/validation, store, DB wiring.
- Admin CRUD + validate/readiness API, caller discovery, dispatch-time
  eligibility enforcement on `postRunHooks`.
- CLI/MCP/OpenAPI/llms.txt discovery surfaces.
- Hook outcome vocabulary + run summary integration + approval-card wording.
- Terminology migration of the four product workflows and their seeds.
- In-workflow static-publish execution for idea-to-product (still driven by
  the runner's REPOBOX_/STATIC_SITE_ env, as before).

## Follow-ups (deliberately out of scope)

- Runner-side execution bridge: transmit the selected profile's config +
  resolved secrets to the runner (via the existing `secretNames`/`secretEnv`
  channel) so hooks run from profile config instead of runner env; executors
  for `git-push`, `webhook`, `vercel-preview`, `custom-script`.
- Hub UI (Settings page) for managing hook profiles.
- Per-run hook events/timeline entries and retry policy.
- Optional seeding of a disabled example profile.
