# CLI stream/follow: Smithers-mirrored run event streaming

Design note for `runyard run --follow` / `runyard logs --follow`, the hardened
Hub SSE stream, and the runner's incremental Smithers event follower.
Branch: `feature/cli-stream-follow` (based on v0.11.17).

## Product contract

External tools invoke RunYard as an ordinary subprocess and receive reliable
incremental workflow updates on stdout, with no knowledge of Smithers,
runners, SSE, or Hub topology:

```bash
runyard run <workflow> -i '{...}' --follow        # create + attach + stream to terminal
runyard run <workflow> --stream-logs              # alias for --follow
runyard logs <run-id> --follow                    # attach to an existing run
runyard logs <run-id> --follow --after-seq 41     # resume from a saved cursor
runyard --json run <workflow> --follow            # NDJSON envelopes, one per line
```

### stdout / stderr

- Text mode: `[<createdAt>] <type>: <message>` per event, then a short
  terminal summary block. `run --follow` prints the usual run-created lines
  first.
- `--json` mode: **stdout carries only NDJSON envelopes**, one per line:
  - `{"kind":"run-created", runId, run, links}` (run --follow only)
  - `{"kind":"event", runId, seq, id, type, message, createdAt, data?}`
  - `{"kind":"terminal", runId, status, exitCode, error?, output?, links}`
- stderr carries every diagnostic: attach notices, reconnect/backoff lines,
  the Ctrl-C detach message. Never mixed into stdout.
- No token or credential is ever printed; stream URLs are path-only and auth
  rides the `Authorization` header.
- Writes go straight to the stdout stream (no block buffering) — pipes see
  each line as it is produced.

### Exit codes (stable)

| code | meaning |
|------|---------|
| 0    | run reached `succeeded` |
| 1    | run reached any other terminal status (failed, cancelled, timed_out, budget_exceeded, …) |
| 2    | usage/input error (unknown run, invalid cursor, bad flags) |
| 3    | transport failure (could not reach/keep a stream to the Hub after bounded retries) |
| 4    | authentication/authorization failure |
| 130  | Ctrl-C — detached **without cancelling** the remote run |

Commander's own parse errors (unknown option/command) and non-follow commands
keep the historical exit 1; the table above is the contract for the follow
paths specifically.

## Source-by-source comparison with Smithers

References read before implementation:
- Pinned 0.22.0 (this repo's `node_modules/.pnpm/@smithers-orchestrator+*`):
  `server/src/index.js` (SSE route), `gateway-client/src/SmithersGatewayClient.ts`
  (`streamRunEventsResilient`, `gatewayBackoffDelay.ts`),
  `cli/src/index.js` (`streamRunEventsCommand`, `events --json --watch`,
  `watch.js`), `db/src/adapter.js` (`insertEventWithNextSeq`, `listEvents`).
- Upstream clone `/home/xiko/smithers-upstream` at origin/main. **Caveat:**
  that checkout reports `v0.25.1-13-g26261399e`, not v0.30.0; the findings
  below describe that tree (`packages/server/src/{index.js,gateway.js}`,
  `packages/gateway-client/...`, `apps/cli/src/index.js`,
  `packages/db/src/adapter.js`).

### What Smithers does

| Concern | Smithers behavior | Where |
|---|---|---|
| Per-run seq | `BEGIN IMMEDIATE; SELECT COALESCE(MAX(seq),-1)+1; INSERT; COMMIT` — 0-based, atomic; `(run_id, seq)` PK as backstop; content-dedupe pre-check | db adapter `insertEventWithNextSeq` |
| SSE route | poll loop every 500 ms, `listEvents(runId, lastSeq, 200)` bounded batches, `event: smithers` + `data: payloadJson`, **no `id:` frames, no Last-Event-ID**, `retry: 1000`, `: keep-alive` every 10 s, `?afterSeq` (default −1), close when run terminal AND batch empty, 404 before stream | server `/v1/runs/:runId/events` (unchanged 0.22 → upstream) |
| Backpressure / caps | On the **WS gateway**, not SSE: per-stream outbound queue capped at 1 000 frames → disconnect that stream with `run.error BackpressureDisconnect`; 8 MB socket high-water with 10 ms drain retry; global connection cap 1 000 (no per-run cap); per-run in-memory replay window of 10 000 frames with `run.gap_resync` under-run; subscriber registered **before** replay so no frame is lost | upstream `gateway.js` |
| Resilient client | resume from last observed `seq` via `afterSeq`; terminal = `run.completed` frame; silent stream end without terminal = 1006 drop → reconnect; backoff base 250 ms ×2 up to 10 s, ±50 % full jitter; backoff resets only after a live (non-replay) frame or `healthyAfterMs` (1 s) | `streamRunEventsResilient` (identical in 0.22 and upstream) |
| CLI follow | `logs -f`: backlog then 500 ms poll of the local DB, terminal drain (batches of 1 000) then exit; `events --json --watch`: NDJSON `{runId, seq, timestampMs, type, payload}` to stdout, watch ≥500 ms interval, terminal drain, warnings to stderr, SIGINT → clean stop (exit 0 in watch; 130 at process level upstream) | cli `index.js`, `watch.js` |

### What RunYard mirrors, one-to-one

- **Persisted monotonic per-run cursor**: `run_events.seq`, 0-based, assigned
  inside the INSERT with the same `COALESCE(MAX(seq),-1)+1` rule
  (`src/runRecords.js`); single-statement atomicity plus a unique
  `(run_id, seq)` index (Smithers' PK backstop). RunYard's Hub is the only
  writer (node:sqlite, synchronous), so `BEGIN IMMEDIATE` is unnecessary; the
  unique index makes a duplicate cursor impossible regardless.
- **SSE route shape** (`src/runReadRoutes.js streamRunEventsResponse`):
  DB-poll loop at 500 ms over bounded 200-event pages from the persisted
  cursor — replay, live tail, reconnect resume, and Hub-restart recovery are
  the same code path, and an attach/backfill race cannot lose events because
  the DB is the only event source. `retry: 1000`, keepalive comment every
  10 s, terminal close only when the run is terminal AND the cursor caught up,
  404/400/429 before the stream opens.
- **Resilient CLI client** (`src/sseClient.js`): `followRunEvents` is a
  transliteration of `streamRunEventsResilient` — same backoff constants and
  jitter formula, same resume-from-lastSeq, same healthy-connection backoff
  reset, same silent-drop-reconnect rule.
- **Runner follower** (`src/runnerSmithersFollower.js`): exactly the Smithers
  CLI's own follow model — one `smithers events <sid> --json --watch
  --interval 1 --limit 100000` child per run; backlog, incremental pages,
  terminal drain, exit 0. Its NDJSON schema is Smithers' `buildEventNdjsonLine`.
- **Slow-consumer bound**: adapted from the gateway's queue-cap disconnect —
  the SSE loop stops reading from the DB when `res.write` reports a full
  buffer and disconnects a consumer that has not drained within 30 s. Memory
  is bounded at one 200-event batch per tail.
- **Caps**: global tail cap (gateway's global connection cap, scaled down:
  256, `RUNYARD_SSE_MAX_TAILS`) plus a per-run cap (32,
  `RUNYARD_SSE_MAX_TAILS_PER_RUN`) → precise 429 before the stream opens.

### Deliberate deviations (and why)

1. **`id: <seq>` frames + `Last-Event-ID`.** Smithers' SSE route has neither
   (its resilient client passes `afterSeq` manually). RunYard emits standard
   SSE ids and honors `Last-Event-ID` (query param wins) so any off-the-shelf
   `EventSource` reconnects without losing events. Strict superset of the
   Smithers contract; required by the task.
2. **Named event `run-event` + `ready` preamble.** RunYard's web console
   already speaks `ready`/`run-event`; renaming to `smithers` would break
   deployed browsers for zero benefit. `ready` gained additive `lastSeq` /
   `afterSeq` fields.
3. **Explicit `run-terminal` frame.** Smithers clients infer terminality from
   engine event payloads (`run.completed`); RunYard Hub events have no such
   guaranteed marker, so the server announces `{runId, status, lastSeq}`
   before the drain-then-close. Unknown named events are ignored by
   `EventSource`, so existing browsers are unaffected.
4. **Wake-on-publish.** Pure Smithers polling costs up to 500 ms of tail
   latency. The Hub's in-process bus (`runEventBus`) is used **only as a
   wake-up signal** for the poll loop — it carries no payload, so there is
   nothing to buffer and no attach race; correctness still comes from the DB.
5. **Bounded reconnect budget in the CLI.** `streamRunEventsResilient`
   retries forever; a scripted CLI must eventually fail. `followRunEvents`
   gives up after 20 consecutive failed attempts (≈3 min of Hub downtime;
   resets on any healthy connection) → exit 3.
6. **No gateway reuse.** The Smithers WS gateway assumes a Smithers server
   process colocated with run state. RunYard's Hub/runner split means the Hub
   holds only mirrored run_events; starting a network-accessible Smithers
   server on runner hosts is explicitly out of bounds. The tested behaviors
   (bounded queues, caps, resume) are mirrored instead of imported.
7. **No in-memory replay window / gap_resync.** The gateway needs a 10k-frame
   ring because its replay source is memory. RunYard replays from SQLite, so
   the full history is always available and a `gap_resync` snapshot frame is
   unnecessary.

## Hub changes

- `run_events.seq INTEGER` + unique `(run_id, seq)` index. Migration
  (`migrateRunEventsSeqColumn`, runs every boot) backfills NULL rows per run
  in `(created_at, rowid)` order continuing from `MAX(seq)` — deterministic,
  idempotent, never renumbers, and sweeps rows written during a downgrade
  window. List order is now `seq` (with a NULLs-last guard).
- `GET /api/runs/:id/events/stream` hardened as above; `/api/v1` alias is
  derived from the same registry entry, so it cannot drift.
- `eventsStreamUrl` (+ `eventsUrl`) added to `runStatusLinks`/`runOutputLinks`
  (run-creation responses) and to `withRunLinks` run payloads, so HTTP and MCP
  consumers discover the transport without holding a tool open. MCP tools are
  unchanged: `get_run_events`/`get_run_timeline` remain the polling fallbacks;
  no indefinitely blocking MCP tool exists.
- The event bus emit happens after persistence (unchanged), and now carries
  `seq` on every published event.

## Runner changes

`runner.js` no longer re-runs `smithers events --limit 100000` every 2 s.
Instead each owned run gets one follower child
(`createSmithersEventFollower`), with:

- serialized `onLine` delivery → Hub event posts keep engine order;
- per-run seq dedupe → a restart's backlog replay never double-posts;
- engine-approval observation, usage extraction (gateway-model exclusion),
  and idempotent usage requestIds unchanged (`createFollowerLineHandler`);
- restart with exponential backoff, give-up after 10 consecutive failures;
- a zero exit is only trusted as "terminal drain complete" after an engine
  inspect confirms the run is terminal (the watch CLI also exits 0 when an
  external signal stops it mid-run); otherwise the follower restarts;
- `stop()` = SIGTERM → SIGKILL after 5 s; followers are tracked in a registry
  killed on runner shutdown — no leaked/zombie children;
- final artifact collection performs exactly one bounded full-history fetch
  after the engine is terminal (the pre-follower behavior — the durable
  smithers-events.ndjson artifact must never be truncated, even by the freak
  externally-signalled-watch-child race), with the follower's accumulated
  lines as the fallback if that fetch fails; nothing re-reads history while
  the run executes;
- the 2 s poll loop remains for control-plane only: `inspect` state, hub
  pause/cancel/terminal observation, approval-hold deadline deferral.

`events` is a control-plane subcommand (reads local `.smithers` state; runs no
untrusted code), so the follower is spawned unwrapped, like every other
polling command (`WRAPPED_SUBCOMMANDS` unchanged). No secrets enter its env
beyond the runner's own inherited environment, and its argv holds only the
Smithers run id. Smithers 0.22's `events --json --watch` was verified to
support this exactly (incremental `afterSeq` paging, ≥500 ms interval clamp,
terminal drain, stderr-only warnings), and the same command shape exists
unchanged upstream — compatible with the planned 0.30 engine upgrade.

## Compatibility / rollout

- Migration is additive and idempotent; event ids, response fields, and
  ordering for existing rows are preserved (backfill follows the old
  `created_at` order with rowid tie-break).
- Existing browser clients keep working: `ready` + `run-event` names kept,
  new frames/fields are additive, LiveConsole's poll fallback untouched.
- A Hub restart cannot break replay: cursors live in SQLite, not the bus.
- Works through Caddy: `X-Accel-Buffering: no`, keepalive comments, and
  standard `Last-Event-ID` reconnects.
- Old runners against a new Hub: fine (POST /events unchanged; seq assigned
  server-side). New runner against an old Hub: fine (follower posts through
  the same endpoint).
- Downgrade window: an old Hub binary writes seq-NULL rows; the next new-Hub
  boot backfills them.

## Hardening notes (from the pre-commit review passes)

- The SSE terminal close re-queries the cursor's emptiness after any
  backpressure drain-wait — a stale caught-up flag could otherwise close the
  stream past freshly persisted tail events. The drain-wait itself is
  released immediately on client disconnect.
- The CLI exits via a flush-then-exit helper: `process.exit` right after the
  last write can discard the terminal NDJSON envelope on a pipe.
- Text-mode output scrubs all C0/C1 control characters (incl. ESC/OSC) from
  run-supplied text so a malicious workflow cannot drive the operator's
  terminal; JSON mode is inherently safe (JSON escaping).
- Runner event posts get two bounded retries — a dropped post can never be
  replayed later (seq dedupe), so the mirrored stream is worth a blip's
  patience. Runner shutdown kills followers before attempting engine
  cancellation, so a cancel failure cannot leak watch children.
- The follower pauses the child's stdout when the undelivered queue exceeds
  1000 lines (resumes at 200), bounding memory during bursts. The
  accumulated `lines[]` history is retained for the terminal
  `smithers-events.ndjson` artifact — the same full-history-in-memory
  profile the previous per-poll `--limit 100000` fetch had.

## Sequencing with `upgrade/smithers-v0.30`

The concurrent upgrade branch (worked in /home/xiko/runyard) also edits
`src/runner.js` (engine-version drift banner, `ENGINE_BEHAVIOR_ENV` on
control-plane invocations, `smithersEventsArgs`, `waiting-quota` pause,
`resumeEngineRun` relaunch in the approval bridge, structured launch-failure
handling). Expected textual conflicts are confined to `runner.js`'s
`fetchEvents` and `executeAssignment`. Merge rules:

1. `spawnSmithersFollower` must adopt the upgrade branch's
   `ENGINE_BEHAVIOR_ENV` (no daemon autostart / no update checks) in the
   follower child env, exactly like the other control-plane commands.
2. Keep the follower as the streaming path and their `smithersEventsArgs`
   only for the single fallback fetch (compose flags, don't resurrect the
   full-history poll).
3. Their `resumeEngineRun` relaunch (engine-approval gates on ≥0.24 exit the
   detached owner) can yield a NEW engine run id. Whenever the bridge
   relaunches, the old follower must be stopped and a new one started on the
   returned sid (or, once on 0.30's CLI, `logs --follow-ancestry` semantics
   evaluated for `events`). Without this the follower keeps watching a
   terminal ancestor and streams nothing from the continuation.
4. The `waiting-quota` pause path is another loop exit — the shared
   `finally` already stops the follower, so no extra cleanup is needed.
5. The Hub-side changes here (seq, SSE, CLI) have no overlap with the
   upgrade branch and merge cleanly.

## Test map

- `tests/run-event-seq.test.js` — migration idempotency/determinism, monotonic
  interleaved inserts, unique-index enforcement, cursor paging.
- `tests/run-read-routes.test.js` — unit: cursor replay, id frames, terminal
  drain-close, keepalive cadence, backpressure pause + slow-consumer
  disconnect, invalid cursor 400, caps 429.
- `tests/run-events-stream.test.js` — real HTTP server: auth 401, 404/400
  before stream, replay + live tail + drain-close, afterSeq/Last-Event-ID
  resume without duplicates, per-run cap 429 + disconnect cleanup,
  attach-race loss-freedom (contiguous seq range).
- `tests/sse-client.test.js` — parser across arbitrary chunk boundaries,
  multi-line data, CRLF, spec EOF discard; backoff math; resume/dedupe;
  fatal-status classification; transport give-up; abort.
- `tests/cli-follow.test.js` — NDJSON/text stdout, stderr separation, exit
  codes 0/1/2/3/4, reconnect dedupe; process-level: real CLI vs stub hub,
  `--stream-logs` alias, Ctrl-C → exit 130 with **no** cancel call.
- `tests/runner-smithers-follower.test.js` — chunked parsing, ordered
  serialized delivery, restart dedupe, clean-terminal completion, give-up,
  SIGTERM/SIGKILL, no zombies.
- `tests/runner-smithers-events.test.js` — follower line handler: approvals,
  event posts, usage idempotency and gateway-model exclusion.
