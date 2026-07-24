# Smithers 0.30 feature-opportunity backlog

Kanban-ready ideas for the RunYard Work board's **Ideas** lane, distilled from
the 0.23–0.30 upstream surface during the engine upgrade
(`docs/design/smithers-030-compatibility.md` has the full matrix). Each entry
states the user value, why 0.30 enables it, the likely RunYard surface,
dependencies, and an acceptance shape. None of these blocks the engine
replacement. **Do not bulk-insert; dedupe against the live board first** —
several overlap with existing product themes (attention queue, approval
sensemaking branches 3–7).

Deliberately rejected (with rationale, not just deferred): upstream
**Monitor/fleet UI as the operator surface** (competes with the Hub as the
single control plane; RunYard's board/attention UI is the product),
**`supervise` auto-resume** (a second resume authority would race the
runner/pause store), **workflow packs as the template channel** (RunYard
ships templates through Hub bundles with hash verification; packs would add a
second trust root), **Postgres/PGlite backend** (SQLite-per-workspace is the
proven runner model), **`smithers pause` for Hub pause** (graceful park
cannot release the runner slot immediately; cancel+checkpoint stays).

---

## 1. Engine event cursors — kill the full-history re-read

- **Value:** the runner re-reads the ENTIRE event history (`--limit 100000`)
  every 2 s poll for every live run; long agent runs make this O(run-length²)
  disk+parse churn on the runner box.
- **Why now:** 0.28+ allocates contiguous per-run `seq` atomically and pages
  internally by `afterSeq`; every NDJSON line carries `seq`. The CLI exposes
  `--since <duration>` only, so the clean path is reading
  `_smithers_events` via the documented seq contract or an upstream
  `--after-seq` flag (worth a PR upstream; the internal query already exists).
- **Surface:** `src/runner.js` poll loop (`fetchEvents` → incremental);
  dedupe key changes from array index to `seq`.
- **Dependencies:** none Hub-side (events already idempotent by
  `engineRunId:seq` requestId for usage rows).
- **Acceptance:** a 10k-event run polls with O(new events) reads (verified by
  strace/timing test); no duplicate or lost `smithers.event`/usage rows
  across a runner restart mid-run.

## 2. Surface engine `startedBy` + `failedChildren` in run detail

- **Value:** operators see who/what launched the engine run (harness,
  session) and which children failed on a "finished" run — sharper
  partial-failure display than the current failing-node text extraction.
- **Why now:** 0.30 persists `startedBy` (the branch already stamps it);
  0.25.1 added `failedChildren`/`failedChildKeys` to inspect/RunFinished.
- **Surface:** `runnerSmithersArtifacts`/`runOutcomePresentation` → run
  detail API/MCP (`engine` block), web RunBanner chip.
- **Acceptance:** run detail shows engine attribution and failed-children
  list when present; API/MCP/OpenAPI/tests in sync (3-stub-list gotcha).

## 3. Engine annotations + parent lineage for resumes

- **Value:** `smithers inspect`/`ps` on the runner box shows the Hub run id,
  capability, and board ticket for every engine run; engine-side resume
  chains (`--parent-run-id`) become navigable lineage.
- **Why now:** 0.30 `--annotations` (flat JSON) + `--parent-run-id`.
- **Surface:** `smithersLaunchRequest` (2 flags), no Hub changes.
- **Acceptance:** every launched run carries `hubRunId`/`capability`
  annotations; bridge resume launches carry `--parent-run-id <original sid>`.

## 4. `smithers why`/`status` as Hub diagnostic enrichment

- **Value:** when a run stalls, the Hub timeline gets the engine's own
  blocker explanation ("waiting on approval X", "quota parked until HH:MM")
  instead of operators SSHing to the runner.
- **Why now:** 0.28 `status`/`why` produce structured blocker verdicts.
- **Surface:** runner poll loop on stall detection; new run event
  `engine.diagnosis`.
- **Acceptance:** a deliberately-parked run shows the engine's why-output in
  its timeline within one poll interval.

## 5. Soft pause (graceful) as a second operator pause mode

- **Value:** today Hub pause cancels the engine run immediately (in-flight
  agent work is lost to the checkpoint boundary). A "finish current step,
  then park" option preserves completed work for expensive steps.
- **Why now:** 0.28 `smithers pause` implements exactly this semantics
  (`pause-requested` → parks `paused` after in-flight tasks; verified live).
- **Surface:** pause API gains `mode: "immediate"|"graceful"`; runner maps
  graceful → `smithers pause`, keeps slot until parked (or slot-releasing
  variant); web pause action gets a second button.
- **Dependencies:** decide slot semantics while `pause-requested` (occupied
  vs released); attention queue copy.
- **Acceptance:** graceful pause on a mid-task run finishes the task, parks
  resumable with checkpoint, and resume completes without re-running the
  finished task.

## 6. Eval suites for workflow templates (`smithers eval`)

- **Value:** regression-test the 21 RunYard templates against real engine
  behavior on every engine upgrade — this upgrade's graph-validation sweep,
  productized.
- **Why now:** 0.30 `eval` runs a workflow over JSON/JSONL suites and writes
  a regression report; `testing` subpath ships a deterministic simulator.
- **Surface:** CI job + `scripts/`; no product surface.
- **Acceptance:** `pnpm eval:templates` (or CI gate) fails when a template
  breaks against the pinned engine.

## 7. Hindsight-backed cross-run memory for factory workflows

- **Value:** the self-development factory (`idea-to-product`,
  `run-knowledge-builder`) re-learns repo context every run; first-class
  memory would carry consolidated facts across runs.
- **Why now:** 0.29 `<Memory>` + Hindsight integration; 0.28 memory notes
  with accept/reject lifecycle.
- **Surface:** workflow templates; runner env (`HINDSIGHT_URL`); capability
  config for memory namespaces.
- **Dependencies:** decide storage/provenance policy (memory outlives runs —
  trust boundary review), SQLite-only for notes.
- **Acceptance:** a factory run demonstrably reuses facts written by a prior
  run (visible in its event stream), and memory contents are inspectable
  from the Hub.

## 8. Time-travel fork/replay as a debugging surface

- **Value:** reproduce a failed run from its last good frame with a tweaked
  input instead of re-running from scratch — big for long factory runs.
- **Why now:** 0.28 hardened fork/replay/timeline; snapshots are
  content-addressed and cheap.
- **Surface:** CLI first (`runyard run fork <id> --frame N`), web later.
- **Acceptance:** fork of a failed run from a chosen frame reaches terminal
  and records lineage to the original.

## 9. Structured event-log panel from `gateway-ui` primitives

- **Value:** the web run view renders `smithers.event` lines as text today;
  the upstream structured `RunEventLog`/`StageStrip` widgets are
  purpose-built for these event shapes.
- **Why now:** 0.30 ships them as importable components (`gateway-ui`).
- **Surface:** web run detail; needs an adapter from RunYard's stored event
  rows to the widget's expected shape (NOT the gateway websocket — keep the
  Hub as the data plane).
- **Dependencies:** bundle-size and design-language review against RunYard's
  UI; reject if it drags the TanStack-DB gateway client in.
- **Acceptance:** run detail event panel groups by node/attempt with stage
  strip, no regression at 360/768/1280/1680 widths.

## 10. `oneshot`-shaped quick task lane

- **Value:** "just do this one thing" runs without authoring a capability —
  RunYard's product-shaped equivalent of upstream `smithers oneshot`.
- **Why now:** 0.30 `oneshot` proves the UX; RunYard already has run drafts +
  negotiation to build on.
- **Surface:** new lightweight capability (`quick-task`) + board quick-add;
  no engine changes.
- **Acceptance:** a one-line ask from the web board becomes a supervised,
  budgeted run with normal artifacts/approvals.
