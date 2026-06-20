# Goal: Put UI-startable runs under the `run-smithers` supervisor and smoke reruns

Fran reported that runs started from the Hub UI were auto-failing when the repo was not selected correctly. We verified two prod failures from 2026-06-20:

- `run_b1f6b7c6af3446e54d59` (`improve`) failed in seconds with `improve target must be a git repository: /home/xiko/smithers-workspace`.
- `run_d3f0ebab79646989a07c` (`implement-change-gated`) failed in seconds with `fatal: not a git repository`.

The previous commit `96a5e64` added the first slice: `supervision.default` on `improve` and `idea-to-product`, plus a repo/project picker. Fran now explicitly asked: “put all of them under the supervisor and re-run a few of them.”

## Objective

Make `run-smithers` the default execution envelope for every normal UI-startable Smithers capability, unless the capability is explicitly internal/low-level and wrapping it would be recursive or nonsensical.

## Required behavior

- Fresh user/API/UI-created runs for normal capabilities should be converted into a `run-smithers` supervising run that wraps the requested capability.
- Prevent recursive wrapping:
  - `run-smithers` itself must never be wrapped.
  - Child runs spawned by `run-smithers` must bypass default supervision using the existing internal supervision token/metadata.
  - Chain/rerun behavior should either be supervised safely or explicitly tested/documented if it must preserve direct semantics.
- Treat “normal UI-startable capabilities” broadly. Do not leave `implement-change-gated` direct-dispatch just because it was not in the previous slice.
- Add clear capability metadata for opt-out if needed, e.g. `supervision: { default: false, internal: true }`, but default should be supervised for user-startable workflow capabilities.
- Make repo-editing workflows impossible to start against `/home/xiko/smithers-workspace` accidentally:
  - `implement-change-gated` needs the same repo/project/repoDir affordance or an explicit configured repo resolution path, not a hidden cwd assumption.
  - Keep raw `repoDir` as an advanced escape hatch with warning text.
  - Prefer friendly repo/project keys and configured catalog/search where available.
- The Hub UI should make supervised runs understandable: users should see the supervising run and child lineage rather than a mysterious wrapper.
- Existing tests should cover default supervision decisions, bypass metadata, and at least one previously-direct capability such as `implement-change-gated`.

## Repo and deployment constraints

- Repo: `/home/xiko/smithers-hub`.
- Bound topic: RunYard / Smithers Hub.
- Build/test/run implementation work on Hetzner only.
- repo.box is publish/serve-only. Do not run builds, installs, tests, Codex/Claude/Smithers workers, or package commands on repo.box.
- Deploy only after local gates pass. Existing prod deployment pattern is acceptable: push/sync audited source/service changes to prod and restart the Hub service, without using repo.box as a build worker.

## Verification gates

Run locally on Hetzner:

- `pnpm test`
- `git diff --check`
- Any targeted tests you add or update.

After deploy:

- Verify prod commit and service health:
  - `https://hub.repo.box/healthz`
  - `https://hub.repo.box/app`
- Re-run/smoke a few capabilities through Hub after the deploy and report deep links:
  - At minimum one cheap non-editing capability, e.g. `research` with a tiny prompt.
  - One repo-editing workflow with no deploy, preferably `implement-change-gated` using an explicit repo/project selection and a harmless/no-op prompt.
  - One workflow that was already in the first slice, e.g. `improve` with `deploy=false` and explicit repo/project.
- For each smoke, verify the top-level run is supervised when expected, child lineage is recorded, and the user-facing run does not auto-fail from `/home/xiko/smithers-workspace` not being a git repo.

## Reporting

When done, report:

- Commit(s) created and deployed.
- Which capabilities are now supervised by default and which are intentionally excluded.
- Test results.
- Smoke run links and outcomes.
- Any remaining caveats.

Keep the final report concise and Telegram-friendly. Do not use tables.
