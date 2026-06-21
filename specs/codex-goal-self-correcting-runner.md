# Goal: Make supervised/self-correcting Smithers runs actually repair workflow-code failures

Context:
- Fran observed, correctly, that the "self-correcting Smithers runner" idea did not work for the new `product-workflow`.
- The first real `product-workflow` run got through `research`, `featureMap`, and `prioritize`, then failed in `dispatch` from a null-safe/report-rendering bug.
- Ocean had to manually fix/sync/rerun before a final report existed.
- That means the current supervision loop is mostly "wrap, retry, diagnose, escalate" rather than "patch workflow bugs, sync runner workspace, rerun, and return a final result."
- Runner logs also showed transition-race noise such as `cannot transition run from 'cancelled' to 'failed'` / `'succeeded'`, which makes recovery look unreliable.

Current evidence:
- Repo: `/home/xiko/smithers-hub`
- Smithers workspace: `/home/xiko/smithers-workspace`
- Failed product runs:
  - `run-1781996504858` failed at `dispatch`
  - `run-1781997160068` failed at `dispatch`
- Follow-up fixed run:
  - `run-1781997351763` finished plan mode and produced Hub/Runyard product recommendations
  - `run-1781997563489` finished but appears to have interpreted Runyard as a generic running app; useful as a UX signal, but not the canonical Hub result
- Relevant files:
  - `workflow-templates/workflows/run-smithers.tsx`
  - `workflow-templates/workflows/run-smithers-watcher.js`
  - `workflow-templates/workflows/product-workflow.tsx`
  - `src/smithers-runner.js`
  - `tests/run-smithers-watcher.test.js`
  - `tests/product-workflow.test.js`
  - `tests/api.test.js`

Task:
1. Inspect the current supervision implementation and runner transition handling.
2. Implement a narrow, real self-correction loop for child workflow-code failures:
   - detect deterministic workflow/template errors from a supervised child run (for example TypeError / failed node / workflow code stack),
   - produce a repair attempt against the workflow template/source in the repo,
   - sync the repaired workflow into the runner workspace when needed,
   - rerun the child once after a repair,
   - preserve the original requested capability/run presentation in the Hub UI/API,
   - stop and escalate with a clear artifact if the same class of failure repeats.
3. Do not make this an unbounded autonomous fixer. Keep caps small and explicit:
   - max one workflow-code repair per supervised child unless existing config already supports a safer limit,
   - no broad repo refactors,
   - no destructive git operations,
   - no duplicate child runs fighting over the same repo.
4. Harden transition-race handling so cancelled terminal runs do not spam scary "cannot transition cancelled to failed/succeeded" errors when a child completes after cancellation.
5. Add tests that would have caught the `product-workflow` failure mode and the cancelled-terminal transition race.
6. If the codebase already has a better local pattern, use it instead of inventing a parallel mechanism.

Acceptance gates:
- `pnpm test`
- targeted tests around `run-smithers-watcher` / runner terminal transitions
- `git diff --check`
- If you change workflow templates, verify the runner-workspace template sync path still works.
- Do not deploy to prod unless all tests pass and the change is clearly ready; report whether deployment was done or intentionally skipped.

Reporting:
- Keep final report concise and Telegram-friendly.
- Include commit id if committed.
- Include exact tests run and pass/fail status.
- Include any remaining caveat, especially if the self-correction loop is intentionally scoped.
