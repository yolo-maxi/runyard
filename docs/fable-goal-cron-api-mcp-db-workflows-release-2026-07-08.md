# Fable Goal: Cron Jobs + API/MCP Workflow Triggering + DB-Workflow Docs + Release

Repo: `/home/xiko/runyard`
Date: 2026-07-08

## User Request

Fran asked:

1. Make sure the chron/cron jobs work properly and can easily trigger workflows.
2. Make sure the chron/cron jobs are fully exposed on the API/MCP.
3. Make sure there are no mentions of "save a workflow.tsx file" anywhere as part of the push to database-backed workflows, and make this well clarified in docs and `llms.txt`/discovery surfaces.
4. Publish and cut a release.

## Current Product Direction

RunYard is moving to DB-backed workflow bundles as the single production runtime path for custom/API-created workflows.

Important prior release:

- `v0.3.9` made public/API-created workflows normalize into DB-backed bundles.
- File-backed execution should now be explicit dev/legacy/internal only.
- Custom/API workflows with only `.smithers/workflows/foo.tsx` should be rejected/blocked instead of accepted as a production path.
- Seed/bootstrap can still publish shipped workflow source into `workflow_bundles` idempotently.

Do not reintroduce copy telling users to save or edit `.tsx` workflow files as the normal way to create workflows. It is okay for internal seed/developer docs to mention repository-authored shipped workflows, but the user-facing/API/MCP/LLM story must be database/source-bytes/bundle based.

## Scope

Implement, verify, commit, push, cut a release, and deploy/restart RunYard if gates pass.

### 1. Cron/schedules work properly and can trigger workflows

Audit the existing schedule/cron implementation and fix any functional gaps. Specifically verify and, if needed, implement:

- Creating a recurring cron schedule that targets a workflow/capability.
- Creating a one-shot schedule if supported by the current model.
- Enabling, disabling, updating, deleting, and listing schedules.
- Previewing cron expressions where the product currently advertises preview.
- The scheduler actually enqueues workflow runs with the intended input, origin metadata, and schedule/run traceability.
- The scheduler does not double-fire on normal polling ticks or service restarts.
- Schedule failures are observable through events/API/logs rather than silent.

Use the product's existing naming if it says "schedules"; do not force UI/API copy to say "cron" everywhere. The important part is that cron-like jobs are first-class and reliable.

### 2. Full API/MCP exposure

Make schedules/cron fully usable through both HTTP API and MCP.

HTTP API should expose the natural schedule lifecycle:

- List schedules.
- Create schedule.
- Get schedule detail.
- Update schedule.
- Enable/disable schedule.
- Delete schedule.
- Run/trigger now if that exists or is expected.
- Preview next fire times for cron expressions if advertised.

MCP should expose equivalent tools so agents can create and manage schedules and trigger scheduled workflows without using the web UI.

Update OpenAPI/discovery docs as needed so API/MCP users can discover the surface.

### 3. Remove misleading file-backed workflow copy

Search the repo for:

- `save a workflow.tsx file`
- `workflow.tsx`
- `.smithers/workflows`
- "save a workflow"
- "write a workflow file"
- similar user-facing copy that implies normal workflow creation is done by placing a TSX file on disk

For user-facing docs, API docs, MCP descriptions, CLI help, landing/docs pages, `llms.txt`/discovery docs, and examples:

- Replace with database-backed language: create/update workflows by sending source bytes/content through API/MCP/CLI/UI; RunYard stores immutable workflow bundles and versions.
- Clarify that file-backed repository workflows are for shipped/internal/dev seed workflows only, not the public production path for custom workflows.
- Make sure `llms.txt` and any generated LLM/discovery docs clearly tell agents to use API/MCP workflow create/update/package/import tools, not filesystem writes.

Keep legitimately historical archive docs only if they are clearly archive/historical. If archive content is indexed into `llms.txt` or user docs, update or exclude it.

### 4. Release/publish

After implementation and verification:

- Commit changes locally with a clear commit message.
- Push `main` to origin.
- Bump version from `0.3.9` to the next appropriate patch release unless repo conventions indicate otherwise.
- Create and push a release tag.
- Create a GitHub release if the repo's existing release flow does not do it automatically.
- Deploy/restart live RunYard services after the release:
  - `runyard.service`
  - `smithers-runner.service`
  - `smithers-support-runner.service`
- Verify live:
  - `https://runyard.repo.box/api/version` reports the new version.
  - `https://runyard.repo.box/readyz` is ready.
  - `/app` is reachable.
  - Runners are registered/online with no unexpected stuck active slots.

Do not build/test on repo.box. Build/test on Hetzner only. repo.box is publish/serve only.

## Required Gates

Loop until these pass or document a real blocker:

- `git diff --check`
- `pnpm test`
- `pnpm build`
- Targeted tests for schedules/cron lifecycle and enqueue behavior.
- Targeted tests for API schedule endpoints.
- Targeted tests for MCP schedule tools.
- Targeted tests or assertions proving user-facing docs/discovery no longer instruct users to save `workflow.tsx` files as the workflow creation path.
- `node --check` on touched JS files where useful.
- Live health checks after deploy/restart.

If release/deploy requires credentials or an unavailable external action, stop after commit/push and report the exact blocker with all green local gates.

## Reporting

When done, report:

- Commit hash.
- Release tag and release URL.
- Summary of API/MCP schedule surface.
- Summary of docs/`llms.txt` cleanup.
- Gate results.
- Live version/health/runners status.
- Any behavior intentionally left as legacy/dev-only.
