# Goal: Rearchitect RunYard Runners To Fail Less

You are working in `/home/xiko/runyard` on `main`.

Fran's objective is explicit: rearchitect the runner layer so RunYard has fewer failure points. Nothing is sacred. Make bold decisions if they reduce real failure modes.

Start from evidence, not vibes:

1. Inspect recent run history, runner rows, run events, and artifacts in the canonical live DB at `/home/xiko/runyard/data/runyard.sqlite`.
2. Identify recurring runner/workflow failure vectors. Include at least these known incidents:
   - `E2BIG: argument list too long, posix_spawn 'claude'` from `run-knowledge-builder` after repeated retries.
   - detached Smithers child processes surviving cancellation/restart and continuing to retry.
   - wrapper/child mismatch where `run-smithers` or `improve` child work succeeds but the parent reports stale/running/blocked.
   - stale runner registry rows marked `online` despite ancient heartbeats.
   - duplicate resume/supervisor loops around recoverable failures.
   - process ownership gaps where detached `smithers up` runs become orphaned or reaped without terminal Hub state.
3. Write focused regression tests that reproduce the failures or prove the new behavior prevents them.
4. Rebuild/refactor the runner architecture to reduce failure points. Prefer deterministic code over prompt/workflow convention where possible.
5. Keep fixing until the gates below pass or a real blocker is documented with exact evidence.

Constraints:

- Do not build, test, install, or run workers on repo.box. This work happens on Hetzner in `/home/xiko/runyard`.
- Preserve user work. If you find unrelated dirty files, stop and inspect before including them.
- Keep secrets out of logs, tests, artifacts, and commits.
- If you change workflow templates, sync any needed runner workspace copies or document exactly why not.
- If you touch live services, restart only what is needed and only after tests pass.
- If a current live run is active, do not kill it blindly. Inspect whether it is real work or stale fallout before acting.

Expected implementation areas may include, but are not limited to:

- runner process lifecycle management and child process ownership
- cancellation propagation to Smithers child runs
- input transport and argument-size protection
- active slot accounting and stale runner pruning
- supervisor/resume/idempotency bookkeeping
- parent/child terminal-state reconciliation
- failure classification and retry policy
- run event/log capture that does not create runaway prompt/process state

Required verification gates:

- Add or update targeted regression tests for the runner failure vectors you address.
- Run focused tests for changed modules.
- Run `pnpm test`.
- Run `pnpm build`.
- Run `git diff --check`.
- Run any relevant live/local smoke checks, such as `/healthz`, runner registration/claim state, and no orphaned matching Smithers processes.

Completion requirements:

- Commit and push the final work to `origin/main`.
- If tests pass and the change affects the live Hub/runner, restart the relevant systemd service(s) and verify live health.
- Update `/home/xiko/clawd/memory/projects/smithers-hub.md` with a concise note: commits, decisions, tests, deploy/restart status, and remaining caveats.
- Leave `/home/xiko/runyard` clean and `main` equal to `origin/main`.
- Report the result clearly: what failure classes are now covered, what changed architecturally, exact commit hash, and verification evidence.
