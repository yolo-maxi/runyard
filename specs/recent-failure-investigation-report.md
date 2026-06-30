# Recent Failure Investigation Report

Date: 2026-06-29 UTC

## Executive Summary

The recent hello-world failure is most likely `run_bd0a56d6bdcd40f1da40`, a `hello` run created on 2026-06-26T20:05:01.929Z. It was assigned to `resume-victim3` / `runner_1e7c7d4958e77d061142`, started the Smithers `hello.tsx` workflow, then escalated after max attempts with fingerprint `runner heartbeat expired`. The local DB has no Smithers event/output artifacts for that run beyond the dispatch event, which supports a runner/heartbeat or resume-supervisor failure rather than a hello workflow-code failure.

Hello-world is currently expected to pass on the live/local setup: the latest `hello` run, `run_059264191fda5164edd7`, was created by schedule on 2026-06-29T08:49:06.992Z, assigned to `hetzner-vps-runner`, emitted normal Smithers events, uploaded output/events artifacts, and succeeded at 2026-06-29T08:49:21.002Z.

The recent failed/timed-out runs are not one class. They include runner heartbeat loss, stalled Smithers resumes that repeatedly emit no events then hit the runner-side 2-hour deadline, canary runner routing pollution, Hub 429 during wrapper supervision, workflow/schema errors, and manual/operator cancellation.

## Run IDs Inspected

### Hello runs

| Run | Created | Status | Runner | Evidence |
| --- | --- | --- | --- | --- |
| `run_bd0a56d6bdcd40f1da40` | 2026-06-26T20:05:01.929Z | failed | `runner_1e7c7d4958e77d061142` / `resume-victim3` | `run.supervisor.escalated`, max attempts, fingerprint `runner heartbeat expired`; only `run-retrospective.json` artifact |
| `run_b39a5f62ecb58a35de86` | 2026-06-26T20:02:28.311Z | succeeded | `runner_1444adb2a5e9b7d2018c` | Smithers events/output artifacts present |
| `run_1de797b3674634c146e6` | 2026-06-26T20:00:04.591Z | succeeded | `runner_f78471a08c251a533ec9` | Smithers events/output artifacts present |
| `run_d3eadc42d32ae4855fab` | 2026-06-26T18:43:37.731Z | succeeded | `runner_65ea0ab9058ae2a407e4` | Smithers events/output artifacts present |
| `run_059264191fda5164edd7` | 2026-06-29T08:49:06.992Z | succeeded | `runner_65ea0ab9058ae2a407e4` / `hetzner-vps-runner` | scheduled one-shot; succeeded in about 14 seconds |

### Recent June 29 failures/cancellations

| Run | Capability | Status | Failure class |
| --- | --- | --- | --- |
| `run_fc0ad9cc9982f94366cb` | `run-smithers` | failed | supervision failed on Hub API 429 while polling child run |
| `run_01608593beba6ed63a64` | `idea-to-product` | failed | workflow/schema failure: task `copy` returned plain text instead of JSON object |
| `run_b6e5c1e44849ba620581` | `run-smithers` | cancelled | wrong runner selected: canary runner claimed production wrapper; later detached Smithers run hit 2-hour deadline and late failure was ignored |
| `run_611b019d7d138cfdb46c` | `run-smithers` | failed | supervised child reached `needs_recovery` and requested approval |
| `run_a59dd3d2d359af246be9` | `implement-change-gated` | failed | workflow input/config validation: `repoDir` and `repo/project` both supplied |
| `run_3f5c96bacaf3bc96d7fc` | `implement-change-gated` | failed | repeated resume attempts against the same Smithers checkpoint; deterministic Smithers init failure, one stall, then max-attempt escalation |
| `run_e9785046818969086bf6` | `run-smithers` | cancelled | paired with operator cancellation at 2026-06-29T22:38:17Z |
| `run_76878708278ad3144040` | `improve` | cancelled | paired with operator cancellation at 2026-06-29T22:38:17Z |

## Hello-World Root Cause

`run_bd0a56d6bdcd40f1da40` failed because the assigned runner stopped heartbeating while the run was active. The event trail is:

- `run.created` with execution location `resumeproof`
- `run.assigned` to `resume-victim3`
- `run.started`
- `runner.started` for `.smithers/workflows/hello.tsx`
- `smithers.dispatched` as `run-1782504304255`
- `run.supervisor.escalated`: `reached maxAttempts (8) without success; operator review required`
- escalation data fingerprint: `runner heartbeat expired`

There are no `smithers-output.json` or `smithers-events.ndjson` artifacts for this failed hello run, unlike adjacent successful hello runs. That makes workflow code, model output parsing, and output artifact upload less likely than runner/heartbeat/resume-supervisor behavior. The run was also explicitly targeted to `resumeproof`, so it exercised the resume/heartbeat test lane rather than the stable production `vps` runner path.

## Recent Timeout And Failure Classes

1. Runner heartbeat loss:
   - `run_bd0a56d6bdcd40f1da40` escalated with fingerprint `runner heartbeat expired`.
   - Earlier stale runner rows still exist with old heartbeats and non-null `current_run_id` values, e.g. `runner_5b4a8cfb99f586963625` and `runner_e058767e5d6ce6afd1d2`.

2. Stalled resume/checkpoint loop:
   - `run_77de09b961764022b864` repeatedly resumed Smithers `run-1782512566240`, emitted no events within the stall window, then hit `runner.deadline_exceeded` after 7200000 ms multiple times before max-attempt escalation.
   - `run_3f5c96bacaf3bc96d7fc` repeatedly resumed Smithers `run-1782763036829`; most attempts failed quickly with the same Smithers init/system error, one attempt stalled, and the Hub escalated after max attempts.

3. Canary runner routing pollution:
   - `run_b6e5c1e44849ba620581` was a production `run-smithers` wrapper but was assigned to `canary-throwaway-runner`, then cancelled with reason "Wrong runner selected for production idea-to-product wrapper".
   - Code evidence: `runnerMatches` only requires capability tags plus execution intent. `run-smithers` requires `["smithers","vps"]`, but runs without an explicit execution intent can match any runner with required tags. A canary runner with broad enough tags can therefore claim work unless the run is targeted or its location tags exclude the canary.

4. Hub/API supervision failure:
   - `run_fc0ad9cc9982f94366cb` failed because the wrapper's Hub GET for child `run_01608593beba6ed63a64` returned HTTP 429.

5. Workflow/code/input failures:
   - `run_01608593beba6ed63a64`: Smithers task returned plain text where schema required a JSON object.
   - `run_a59dd3d2d359af246be9`: improve repo resolver rejected mutually exclusive `repoDir` and `repo/project`.
   - `run_3f5c96bacaf3bc96d7fc`: repeated Smithers system/init failure in `implement`.

6. Operator/manual cancellation:
   - `run_e9785046818969086bf6` and `run_76878708278ad3144040` were cancelled around 2026-06-29T22:38:17Z.

## Runner And Service State

Read-only service inspection showed:

- `runyard.service`: active since 2026-06-29T08:33:36Z, running `/home/xiko/runyard/src/server.js`.
- `smithers-runner.service`: active since 2026-06-29T23:02:56Z, registered `runner_65ea0ab9058ae2a407e4` with tags `smithers,vps,reauth,remote`, capacity 4.
- `smithers-support-runner.service`: active since 2026-06-29T23:02:56Z, registered `runner_13380026cc00bf344df2` with tags `support,vps,remote`, capacity 2.

The runner table currently contains live production/support runners plus a live-looking `canary-throwaway-runner` row with `current_run_id=run_3f5c96bacaf3bc96d7fc` and `active_runs=1`, even though the Hub service log is repeatedly reconciling that runner from `1->0`. That is evidence of stale or conflicting runner state, and it can confuse operator diagnosis even if claim capacity now derives from durable run state.

No support-run pollution was found in recent normal runs: querying June 29 runs for support capability slugs returned no rows.

## Is Hello Currently Runnable?

Yes, based on existing read-only evidence. `run_059264191fda5164edd7` succeeded on 2026-06-29T08:49:21.002Z on the production `hetzner-vps-runner`, and the current production runner service is active and heartbeating. I did not enqueue a new live hello run because the investigation guardrails said not to mutate production state or spend model tokens unless necessary.

## Recommended Next Actions

1. Keep hello on the stable production runner path by default. Avoid using resume/canary/throwaway runner locations for user-visible hello-world checks unless the test explicitly labels itself as a runner-resume test.
2. Remove or quarantine canary runners from production claim matching. The canary runner should not be able to claim production `run-smithers` or `idea-to-product` wrappers by broad `smithers`/`vps` tags.
3. Fix stale runner state display and cleanup. Rows with old heartbeats or stale `current_run_id` should not appear healthy, and `current_run_id` should be cleared when the referenced run is terminal.
4. Tighten Hub supervisor resume policy for no-event/stalled checkpoints. Repeated resumes of the same Smithers run with no events should stop earlier or switch to a fresh run where safe instead of waiting for repeated 2-hour runner deadlines.
5. Add a cheap, non-model hello health check or a pinned deterministic hello workflow so the platform can continuously verify runner claim/start/artifact plumbing without model variability or token spend.
6. Investigate and tune Hub API rate limits for in-band `run-smithers` supervision, because a child status poll returning 429 directly failed a wrapper run.

## Verification Commands Used

```bash
sed -n '1,240p' specs/codex-goal-recent-failure-investigation.md
git status --short
rg --files data | sort
sqlite3 data/runyard.sqlite '.tables'
sqlite3 -header -column data/runyard.sqlite "select id, capability_slug, status, runner_id, current_step, created_at, assigned_at, started_at, completed_at, substr(coalesce(error,''),1,220) as error from runs where capability_slug='hello' order by created_at desc;"
sqlite3 -header -column data/runyard.sqlite "select type, created_at, substr(message,1,500) as message, substr(data,1,500) as data from run_events where run_id='run_bd0a56d6bdcd40f1da40' order by created_at;"
sqlite3 -header -column data/runyard.sqlite "select id, name, tags, status, current_run_id, capacity, active_runs, created_at, last_heartbeat_at from runners order by datetime(last_heartbeat_at) desc;"
sqlite3 -header -column data/runyard.sqlite "select distinct r.id, r.capability_slug, r.status, r.created_at, r.assigned_at, r.started_at, r.completed_at, r.runner_id, substr(coalesce(r.error,''),1,260) as error from runs r left join run_events e on e.run_id=r.id where r.created_at >= '2026-06-26T00:00:00' and (e.type='runner.deadline_exceeded' or r.error like '%deadline%' or r.error like '%timed out%' or r.error like '%Timed out%' or r.error like '%execution deadline%') order by r.created_at desc;"
sqlite3 -header -column data/runyard.sqlite "select r.id, r.capability_slug, r.status, r.created_at, r.assigned_at, r.started_at, r.completed_at, r.runner_id, substr(coalesce(r.error,''),1,300) as error from runs r where r.created_at >= '2026-06-29T00:00:00' and r.status in ('failed','cancelled') order by r.created_at;"
sqlite3 -header -column data/runyard.sqlite "select type, created_at, substr(message,1,500) as message, substr(data,1,500) as data from run_events where run_id='run_b6e5c1e44849ba620581' order by created_at;"
sqlite3 -header -column data/runyard.sqlite "select type, created_at, substr(message,1,500) as message, substr(data,1,500) as data from run_events where run_id='run_77de09b961764022b864' order by created_at;"
systemctl --no-pager --plain list-units '*runyard*' '*smithers*' '*runner*' --all
systemctl --no-pager --plain status runyard.service smithers-runner.service smithers-support-runner.service
tmux ls
ps -eo pid,ppid,etimes,cmd | rg -i 'runyard|smithers-runner|runner|server.js|node' | rg -v 'rg -i'
sed -n '1460,1555p' src/db.js
sed -n '1910,2010p' src/db.js
sed -n '2390,2470p' src/db.js
sed -n '1,220p' src/runExecution.js
sed -n '1,260p' src/runner.js
```

`git diff --check` was run after writing this report and passed.
