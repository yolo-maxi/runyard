# Goal: Add LLM obstruction analysis to terminal run retrospectives

Fran correctly pushed back that the current default `run-retrospective.json` is not useful enough if it only records status/metadata. Failure alone is weak signal, and successful runs can still reveal obstructions when they take longer than they should or require awkward workarounds.

Implement a Hub-level v1 that adds an LLM-assisted obstruction analysis artifact for every terminal run, layered on top of the deterministic retrospective.

## Product intent

Every terminal run should still get the deterministic `run-retrospective.json`.

In addition, the Hub should best-effort produce an obstruction-focused analysis artifact that highlights what made the task harder than expected, including successful runs.

This must remain artifact-only. Do not auto-edit workflows, agents, skills, prompts, knowledge, or templates in this pass.

## Desired behavior

- For terminal runs (`/complete`, `/fail`, `/cancel`, stale-run auto-fail), generate an LLM obstruction analysis artifact by default when enough evidence exists.
- Suggested artifact names:
  - `run-obstruction-analysis.json` for structured machine-readable output.
  - Optional `run-obstruction-analysis.md` for human-readable scanability if the repo pattern supports paired report artifacts cleanly.
- The analysis should explicitly look for:
  - blockers and failed steps;
  - missing context or unclear goal;
  - tool/path/env/runner issues;
  - approval friction;
  - retries, repeated errors, or fallback behavior;
  - long queue/execution/total time relative to the run shape;
  - human corrections or requested changes visible in events/log summaries;
  - workflow/agent/skill design issues;
  - artifact/output gaps;
  - successful-but-painful runs where the task completed but the process was unnecessarily slow, noisy, or fragile.
- Output should separate evidence from inference. The artifact should not pretend confidence when logs are thin.
- Include a concise severity/confidence model, for example:
  - `none`, `low`, `medium`, `high` obstruction severity;
  - confidence based on the amount/quality of evidence.
- Include actionable recommendation fields, but only as proposals:
  - `observations`;
  - `obstructions`;
  - `suggestedWorkflowImprovements`;
  - `suggestedAgentImprovements`;
  - `suggestedSkillOrKnowledgeImprovements`;
  - `followUpQuestions`;
  - `doNotAutoMutate: true`.

## Implementation constraints

- This is Hub/runner-level plumbing, not something individual workflow templates must remember to call.
- Keep the deterministic retrospective generation cheap and reliable.
- The LLM pass must be best-effort and non-blocking:
  - terminalization must still succeed if the LLM call fails;
  - record an event such as `run.obstruction_analysis_failed` on failure;
  - do not prevent `/complete`, `/fail`, `/cancel`, or stale cleanup from finishing.
- Redact inputs/prompts/log snippets. Do not send raw secrets, env files, full raw inputs, full raw outputs, or full artifact contents to the LLM.
- Use existing local patterns for model/LLM calls if present. If there is no existing provider abstraction, create the smallest conservative abstraction and make it easy to disable/configure.
- If no LLM provider is configured in dev/test, tests should still pass using an injected fake/analyzer stub.
- Avoid duplicate analysis artifacts when terminalization is retried.
- Do not introduce npm; use pnpm only.
- Do not deploy unless tests pass.

## Investigation hints

- Existing retrospective implementation:
  - `src/runRetrospective.js`
  - terminalization wiring in `src/server.js`
  - artifact/event helpers in `src/db.js`
  - tests in `tests/run-retrospective.test.js` and `tests/api.test.js`
- Search for existing LLM/provider/agent invocation patterns before inventing a new one.
- Preserve current behavior that `run-retrospective.json` is created for complete/fail/cancel/stale terminal paths.

## Verification gates

Run and keep fixing until clean:

- `pnpm test`
- `git diff --check`
- Targeted tests covering:
  - obstruction analysis is produced for a successful terminal run with warning/slow/retry evidence;
  - obstruction analysis is produced for a failed run;
  - obstruction analysis failure records an event and terminalization still succeeds;
  - no duplicate analysis artifact on repeated terminalization;
  - redaction / bounded prompt payload behavior;
  - analysis is artifact-only and sets no auto-mutation behavior.

## Delivery

- Commit all changes to `origin/main` if tests pass.
- Deploy to production only after tests pass, using the repo's existing deploy path and keeping repo.box publish-only constraints in mind.
- Verify live:
  - `https://hub.repo.box/healthz`
  - `https://hub.repo.box/app`
  - at least one smoke run that terminalizes and includes `run-retrospective.json` plus obstruction analysis artifact(s).
- Report back with:
  - commit hash;
  - test count;
  - deployed/live status;
  - smoke run deep link;
  - artifact names observed.
