# Workflow Hardening and Optimizer

Runyard should not only run agent workflows. It should improve them until repeated parts become deterministic software.

## run-smithers: the supervising wrapper

The core process direction is that every user-facing workflow runs inside a
higher-level Smithers process called `run-smithers`. The wrapper is a normal
Runyard capability (slug `run-smithers`, category Orchestration) that wraps a
single child capability/workflow request. The watcher:

- Records child lineage: child run id, wrapped capability slug, current/failed
  step, checkpoint when the child carries one, recovery attempt count, the
  normalized error fingerprint per attempt, and the final outcome.
- Re-queues the child run on transient failure and resumes from the recorded
  checkpoint when the runner exposes one.
- Stops autonomous retry and creates an approval with three concrete options
  (retry as-is, approve a revised input/recovery plan, abandon the goal) once
  the same normalized error fingerprint appears three times.
- Never marks the supervising run a success unless the child workflow itself
  reaches a terminal `succeeded` state. Any other outcome is `needs_recovery`
  or `abandoned` — failure is never silently masked.

The watcher's pure decision logic lives in `src/runSmithersWatcher.js`. The
runtime contract (state shape, classification, three-strike rule) is covered
by `tests/run-smithers-watcher.test.js`. Existing capabilities continue to
work standalone and are migrating to run behind `run-smithers` so every
long-running goal carries the same lineage and recovery semantics.

## Smithers samples reference corpus

Runyard uses `https://github.com/dennisonbertram/smithers-samples` as a
reference corpus for Smithers 0.24.x workflow behavior. The repo is not
vendored into Runyard; instead, high-signal patterns and gotchas are translated
into Runyard docs, helper functions, and regression tests.

Patterns to keep:

- `durable-fix-until-green`: agent edit, deterministic test, bounded retry,
  resumable continuation. This is the desired shape for implementation and
  repair loops.
- `content-quality-loop`: writer, judge, revise until threshold. Loop logic
  must read the latest iteration output, not the first row.
- `cost-aware-model-router`: cheap-first model attempts with verifier gates,
  escalation, and explicit cost attribution. This is the future direction for
  `run-smithers` and `improve` model policy.
- `multi-agent-code-review`: parallel specialist review, judge synthesis, then
  human approval before posting/applying a decision.
- `resilient-etl-saga`: side effects should have compensation or a terminal
  audit record; response endpoints and webhooks should not be fire-and-forget.

Gotchas to enforce:

- Smithers approval exit code `3` means paused for approval, not failed.
- Resume, replay, and fork depend on stable workflow source/hash; Runyard
  should pin capability versions and avoid mutating a workflow mid-resume.
- Scorer output is not guaranteed to appear in event NDJSON; tooling that needs
  scorer data must read scorer storage or an explicit scorer API.
- Fractional values persisted through Smithers/SQLite should use strings unless
  integer truncation is intended.
- Output fields named `nodeId`, `runId`, or `iteration` collide with Smithers
  internal columns; use domain-specific names instead.
- Non-Anthropic agents may need `nativeStructuredOutput: true` when a workflow
  expects pure structured rows.
- Loop exits and revisions should use latest-output semantics.

The deterministic guardrails for these lessons live in
`src/smithersHardening.js` with coverage in
`tests/smithers-hardening.test.js`.


The guiding process order is:

1. Question requirements.
2. Delete unnecessary steps.
3. Simplify and optimize.
4. Accelerate cycle time.
5. Automate.

In Runyard, "automate" does not mean replacing humans with agents. It means replacing agent judgment with machine-checkable scripts, code, and tests when a step has become repeatable.

## Product Thesis

Agents are excellent at discovering process. They inspect a repo, try commands, write shell scripts, debug failures, and learn which checks matter.

That knowledge should not stay buried in transcripts. Runyard should capture it, extract it, and harden it into workflow infrastructure.

The desired gradient is:

- Raw agentic work.
- Constrained agentic work with explicit input/output contracts.
- Checkpointed agentic work with recovery policy.
- Script-backed work where agents handle exceptions.
- Deterministic code with tests.
- Automated machine steps with anomaly escalation.

Creative judgment, taste, prioritization, and ambiguous product calls may remain agentic. Engineering plumbing, setup, verification, deployment, routing, parsing, and artifact handling should harden aggressively.

## Hardening Levels

### L0: Raw Agentic

The step is mostly a prompt. Inputs and outputs may be loosely described. Variance is expected.

Use when:

- The problem is new.
- The output shape is not known.
- Human taste or exploration matters.

### L1: Constrained Agentic

The step has explicit input and output contracts, but an agent still decides how to satisfy them.

Required metadata:

- Purpose.
- Required inputs.
- Expected outputs.
- Acceptance checks.
- Known failure modes.

### L2: Checkpointed Agentic

The step writes enough state for recovery.

Required metadata:

- Last successful checkpoint.
- Recovery command or recovery prompt.
- Error fingerprint.
- Retry count for the same fingerprint.
- Conditions that require approval.

### L3: Script-Backed

The common path is a script or command sequence. An agent supervises exceptions and edits the script only when the process changes.

Required metadata:

- Script path.
- Arguments.
- Expected files.
- Test command.
- Owner workflow step.

### L4: Deterministic Code

The step is implemented as code with tests and a typed contract.

Required metadata:

- Code entrypoint.
- Input schema.
- Output schema.
- Unit/integration tests.
- Upgrade procedure.

### L5: Automated Machine Step

The step runs without an agent in normal operation. An agent or human is only invoked for anomaly handling.

Required metadata:

- Anomaly detector.
- Alert target.
- Rollback or compensation path.
- Human approval policy, if required.

## Optimizer Loop

The nightly optimizer should act like a process-improvement worker, not a generic "make it better" agent.

It should:

1. Pick representative workflows and fixtures.
2. Re-run them in isolated run workspaces.
3. Diff outputs, artifacts, timing, and failure modes.
4. Identify high-variance, high-cost, high-failure, or high-token steps.
5. Ask whether the step can be deleted.
6. If not deleted, ask whether it can be split smaller.
7. If stable, extract scripts or commands from the run trace.
8. If script-backed, propose code with tests.
9. Open a Runyard improvement run or PR with evidence.
10. Re-run workflow fixtures to prove the simplified path still works.

The optimizer should prefer deletion and simplification over adding more agents.

## Script Extraction

Agents often create useful local scripts while working. Runyard should treat those scripts as process discoveries.

Examples:

- A shell snippet that verifies deploy prerequisites.
- A Node script that parses Smithers events.
- A Playwright check that confirms a canvas is nonblank.
- A static-site audit command.
- A package setup command sequence.

The optimizer should extract these into durable workflow assets when they recur.

Extraction criteria:

- The same command pattern appears in multiple successful runs.
- The output is easy to verify.
- Failure modes are known.
- The step can be run without broad agent discretion.
- The script can be tested against fixtures.

## Atomicity and Recovery

Hardening must support the Runyard reliability model:

- Draft work may exist inside isolated run workspaces.
- Promotion is atomic: commit, publish, deploy, or mark-live only happens after final checks.
- If a workflow fails after useful checkpoints, status becomes `needs_recovery`, not generic `failed`.
- Recovery runs link back to the original run.
- Manual/Ocean recovery must also create Hub lineage.

This avoids abandoned half-finished artifacts while preserving useful work.

## Side Effects and Replayability

Every new workflow, and every deploy/promotion step added to an existing
workflow, must include an explicit side-effect and replayability review before
it is shipped.

Classify each step as one of:

- `pure`: reads state and writes only normal workflow outputs.
- `workspace-local`: mutates only an isolated run worktree, temp directory, or
  artifact path that can be safely deleted.
- `external-side-effect`: changes shared state outside the run, such as pushing
  a branch, merging to `main`, publishing a package, deploying a service,
  sending a webhook, writing production data, posting to chat, or charging an
  account.

Rules:

- Do not put `external-side-effect` steps before cheap validation, baseline
  checks, and config preflight. Fail before mutation whenever possible.
- Do not make a checkpoint automatically replayable after an
  `external-side-effect` step. Retrying from that checkpoint may repeat the
  mutation.
- Split dangerous side effects into their own promotion/finalization operation
  when possible. The expensive agent work should be retryable; the merge,
  push, publish, deploy, or cleanup should be a smaller retriable operation.
- If a side-effect step may partially succeed, record the exact external
  identity it touched: commit SHA, branch name, worktree path, artifact URL,
  deployment id, remote ref, message id, payment id, or database migration id.
- On failure after a side effect, park or request approval instead of
  resuming blindly. The recovery plan should say whether to retry only the
  finalization step, compensate/rollback, or abandon.
- Successful finalization should clean up isolated branches/worktrees/artifacts
  that are no longer needed. Failed finalization should leave enough state for
  inspection and retry.

Treat replay safety as a contract, not an implementation detail. A workflow can
fail after useful work has already mutated the outside world, so "has a
checkpoint" is not proof that replay is safe.

## Step Metadata

Every workflow step should eventually expose:

- `purpose`
- `hardeningLevel`
- `sideEffectClass`
- `replayPolicy`
- `compensationPolicy`
- `requirementOwner`
- `inputSchema`
- `outputSchema`
- `acceptanceChecks`
- `checkpointPath`
- `scriptPath`
- `tests`
- `varianceScore`
- `failureRate`
- `averageDurationMs`
- `averageTokenCost`
- `approvalPolicy`
- `knownFailureModes`
- `nextHardeningCandidate`

The Web UI should show this on workflow graphs so operators can see which parts are still agentic and which parts have compiled into code.

## Product Implications

Runyard should become a workflow compiler:

- Start with agentic workflows.
- Observe repeated behavior.
- Extract repeatable process.
- Delete unnecessary steps.
- Harden stable pieces into scripts and code.
- Keep agents where ambiguity, taste, or approval is valuable.

The platform should make this progression visible and measurable.
