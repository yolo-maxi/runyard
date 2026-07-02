# Live-Sync Migration: polling → push-live run detail

This spec defines how Runyard moves the run UI from HTTP polling to a genuinely
live, push-based layer while keeping the existing Express + `node:sqlite` Hub as
the source of truth and keeping all 23 Playwright e2e tests green at every phase.

## Goal

- The run **detail** page (`renderRunDetail`, `public/app.js:3248`) becomes
  genuinely live: status transitions (`queued → running → succeeded/failed`) and
  new log events appear with no `hashchange`, no `softRefreshDetail` hash-bounce,
  and no `location.reload()`.
- The run **list** stays live exactly as today (the e2e-pinned 4s in-place
  `[data-run-progress]` swap), now driven by the same live-query layer.
- The client data layer mirrors `../multi` / `smithers/apps/smithers`: the real
  published `@smithers-orchestrator/gateway-client` + `@smithers-orchestrator/gateway-react`
  collections and hooks, on top of `@tanstack/db` / `@tanstack/react-db`.

## Chosen approach

**Pragmatic hybrid: a runyard-owned `SyncTransport` adapter over Runyard's own
SQLite, handed to the published `createGatewayCollections`** — reuse the
`runs` / `run` / `runEvents` collections and the `useGatewayRuns` /
`useGatewayRun` / `useGatewayRunEvents` hooks verbatim; deliberately skip the
devtools `nodes`/tree collection (Runyard stores flat typed log events, not a
node graph, so it cannot cheaply back `getDevToolsSnapshot`/`streamDevTools`).

We keep `@smithers-orchestrator/gateway-client` as a declared dependency for
parity with `../multi`'s intent, but we implement `SyncTransport` ourselves over
**SSE**, not the gateway WS wire protocol. The `SyncTransport` interface is the
documented extension seam (`SyncTransport.ts:1-8`: "tests pass a stub; production
passes a `SmithersGatewayClient` adapter") — a custom transport is first-class.

### Why this and not the alternatives

- **Mirrors multi where it matters.** The live-query brain — collections, hooks,
  `@tanstack/db` — is byte-for-byte the multi/smithers consumer pattern
  (`createGatewayCollections`, `SyncProvider`, `useGatewayRuns`/`useGatewayRun`/
  `useGatewayRunEvents`). We diverge only on the transport, which is the seam.
- **Smallest correct server.** Runyard already owns its SQLite source of truth.
  Speaking the gateway WS wire protocol (connect handshake, `/v1/rpc` framed
  envelopes, `streamId`, `{type:'event'}` frames) would buy nothing. We add only:
  one `seq` cursor, a ~40-line in-process emitter, one SSE route.
- **Honest divergence from "use gateway-client".** We keep `gateway-client` in
  `package.json` for type/parity reasons but do **not** route traffic through its
  WS client. If we wanted zero gateway-client coupling we would drop it entirely
  (the "Native, no gateway-client" variant); we keep it to honor the stated
  "mirror multi / gateway-client + TanStack DB" intent, while being explicit that
  the transport is a Runyard-specific SSE adapter, not the gateway WS wire.
- **SSE, not WS.** EventSource sends the same-origin signed `shub_session` cookie
  automatically (no `Authorization` plumbing — EventSource can't set headers),
  CSP `connect-src 'self'` (`server.js`) already permits it with **no header
  change**, and it needs **no new npm dependency** (a raw WS would need `ws`).
  `Last-Event-ID` gives free `afterSeq` resume on reconnect.

### What we explicitly skip

- `useGatewayRunTree` / the `nodes` devtools-tree collection and its
  `getDevToolsSnapshot` + `streamDevTools` surface. Runyard's `run_events` are
  flat typed rows (`type`, `message`, `data`), not a node graph. The live detail
  page is **status + event log**, not a node tree. Re-adding the tree later is a
  separate, larger effort and **must not** be done casually — it would re-couple
  Runyard to the heavier registry.
- The gateway WS wire protocol (Option B in the contract): no framed `/v1/rpc/*`
  responses, no `connect` handshake, no `streamId`, no `{type:'event'}` frames.

## Dependencies

Add as registry deps (versions match `../multi`):

- `@smithers-orchestrator/gateway-client@^0.24.2`
- `@smithers-orchestrator/gateway-react@^0.24.2` (pulls `@smithers-orchestrator/gateway@0.24.2` transitively for RPC types)
- `@tanstack/react-db@^0.1.86`
- `@tanstack/db@^0.6.8` (transitive via gateway-client; ensure exactly ONE copy in the bundle)
- `react@^19` / `react-dom@^19` — already devDeps; the island MUST reuse the
  single React already bundled in `reactflow.bundle.js` (see Frontend design).

No new runtime server dependency: SSE is plain Express; no `ws`, no EventSource
polyfill (browser-native).

**Pin exactly `^0.24.2` as multi does** and add a contract smoke test (below): a
gateway-react minor that silently changes the frame contract (`frame.payload.event`
values, numeric-`seq` keying, the `run`-collection-has-stream / `runs`-collection-
refetch split) breaks the adapter with empty live data and no error.

---

## Server design

All writes land in the Hub process: the separate runner writes run state ONLY via
the Hub HTTP API (verified — `src/smithers-runner.js` only does `client.post/get`,
never opens SQLite). `src/db.js` is the sole SQLite owner. Therefore an in-process
emitter hooked into `db.js` write funnels sees every mutation — including the
reaper (`reapStuckRuns`) and `resolveApproval`, which mutate via `transitionRun`.

### 1. Monotonic replay cursor on `run_events`

`run_events` today is `id TEXT PRIMARY KEY` (random `evt_<hex>`) ordered only by
ms-resolution `created_at` (`db.js:168-175`, `listRunEvents` `db.js:1120`) — NOT a
safe `afterSeq` cursor (ISO strings collide within a millisecond).

Add a monotonic `seq` seeded from the implicit, already-monotonic `rowid` (the
table is a normal rowid table, NOT `WITHOUT ROWID`). **Prefer rowid-seeded `seq`
over a per-insert `SELECT MAX(seq)+1`** — the latter races under WAL and costs a
query per insert; rowid is monotonic for free.

In `initSchema()`, add an idempotent migration mirroring `migrateRunnersPoolColumns`
(`db.js:268`):

```sql
ALTER TABLE run_events ADD COLUMN seq INTEGER;          -- if column absent
UPDATE run_events SET seq = rowid WHERE seq IS NULL;     -- one-time forward-only backfill
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq ON run_events(run_id, seq);
```

In `addRunEvent` (`db.js:1111`, the single insert funnel), set `seq = rowid` of
the just-inserted row (read `lastInsertRowid` from the insert, or
`SELECT seq FROM run_events WHERE id = ?` immediately after). Return `seq` in the
event object.

Extend `listRunEvents(runId, { afterSeq } = {})` (`db.js:1120`):

```sql
SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC
```

and include `seq` in each returned row shape. `afterSeq` defaults to `0`.

> Guard: a future direct `INSERT INTO run_events` that bypasses `addRunEvent`
> would be invisible to the stream. Keep `addRunEvent` the sole insert site.

### 2. In-process emitter: `src/runStream.js` (new, ~40 lines)

A `Map<runId, Set<subscriber>>` plus emit helpers (no Node `EventEmitter`
required, but it may wrap one):

```
subscribe(runId, fn) -> unsubscribe   // adds fn to the run's subscriber set
emitEvent(runId, eventRow)            // { kind:'event', runId, seq, type, message, data, createdAt }
emitStatus(runId, run)                // { kind:'status', runId, run }
```

Hook the **two db.js chokepoints** (both verified single funnels; hooking at the
db.js layer — not the HTTP handlers — is required to catch reaper/approval
transitions):

- `addRunEvent` (`db.js:1111`) — call `emitEvent(runId, row)` right before `return`.
- `transitionRun` (`db.js:1087`) / `updateRun` (`db.js:1055`) — call
  `emitStatus(runId, updatedRun)` on success.

This transitively covers `createRun`, `resolveApproval`, `claimNextRun`, the
reaper, chaining, and every HTTP handler, since they all route through these two.

`db.js` imports `runStream`; `runStream` imports nothing from `db.js` (avoid a
cycle — emit is push-only with plain row objects).

### 3. SSE endpoint: `GET /api/runs/:id/stream`

New route in `src/server.js`, next to `/api/runs/:id/events` (`server.js:2614`),
behind `requireAuth` + `requireScopes("api")`. The signed `shub_session` cookie
rides automatically on the same-origin GET.

Behavior:

1. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`; flush headers; disable the response timeout.
2. Read resume cursor from the `Last-Event-ID` request header (EventSource
   auto-sends the last `id:` it saw on reconnect) or `?afterSeq=`.
3. **Replay**: `listRunEvents(id, { afterSeq })` as discrete SSE messages, each
   `id: <seq>\nevent: run.event\ndata: <json>\n\n`. Also emit one initial
   `status` message from the current `getRun(id)` so a freshly-opened stream
   seeds the banner immediately.
4. **Subscribe**: `runStream.subscribe(id, fn)`; write each live `emitEvent`/
   `emitStatus` as an SSE message (events carry `id: <seq>`; status messages
   carry no `id`).
5. Heartbeat: `: hb\n\n` comment every ~15-20s (keeps EventSource alive past
   proxy idle timeouts; counts as ONE request against the `/api` rate limit).
6. Cleanup: `req.on("close", unsubscribe)`.

> **WAL hazard:** read events with discrete queries per emit. NEVER hold a
> `node:sqlite` transaction or streaming cursor open across the long-lived SSE
> connection (single synchronous `DatabaseSync` + WAL).

**Auth allowlist:** `telegramSessionCanAccess` (`server.js:1232`) gates
`telegram-webapp` sessions to an allowlist of GET routes. Its runs regex today is
`/^\/api\/runs(?:\/[^/]+(?:\/(?:events|logs|artifacts))?)?\/?$/`. Extend the inner
alternation to include `stream`:
`/^\/api\/runs(?:\/[^/]+(?:\/(?:events|logs|artifacts|stream))?)?\/?$/` so
telegram-webapp cookie sessions can read the new stream.

### RPC methods (no new HTTP routes required)

The adapter's `rpc('listRuns')` and `rpc('getRun')` reuse the **existing**
endpoints via the existing `api()` fetch wrapper and reshape rows client-side:

- `rpc('listRuns', { filter? })` → `GET /api/runs`, map `{ runs: [normalizeRun] }`
  → `Array<GatewayRunSummaryRow>`.
- `rpc('getRun', { runId })` → `GET /api/runs/:id`, map `{ run: normalizeRun }`
  → one `GatewayRunRow`.

**Row-shape mapping (load-bearing — `getKey` is `runId`):** `normalizeRun` uses
`id`/`createdAt`; the Gateway rows want `runId`/`createdAtMs`. The adapter must
map `id → runId`, `createdAt → createdAtMs` (ISO → epoch ms), keep `status`,
`workflowKey` (`capabilitySlug`), and pass through the rest. A row missing
`runId` is dropped silently by the collection, so this mapping is mandatory.

The adapter returns the **unwrapped payload** (Option A) — no `GatewayResponseFrame`
envelope. We do NOT add `POST /v1/rpc/*` routes.

### afterSeq replay design

- The transport's `stream('streamRunEvents', { runId }, { afterSeq, signal })`
  opens `new EventSource('/api/runs/' + runId + '/stream' + (afterSeq ? '?afterSeq=' + afterSeq : ''))`.
- The server replays `listRunEvents(runId, { afterSeq })` off the new `seq`
  column BEFORE subscribing live, then tails new rows — exact resume, no gap.
- The server sets `id: <seq>` per event message, so EventSource auto-resends
  `Last-Event-ID` on a dropped connection and the server resumes from there.
- Heartbeat comments carry no `id` and never become frames.

---

## Stream design (SSE) and frame format

**Choice: SSE.** Auth: same-origin cookie, zero client auth code. CSP: no change.
Dependency: none.

The transport wraps EventSource in an `AsyncIterable<SyncStreamFrame>` (push SSE
messages into a queue + resolve a pending `[Symbol.asyncIterator]` iterator).
`opts.signal.onabort → eventSource.close()`.

Each SSE `event: run.event` message maps to a `SyncStreamFrame` exactly as
`gatewayCollectionDefs.run` / `gatewayCollectionDefs.runEvents` expect:

```js
{
  key: ['gateway:streamRunEvents', { runId }],
  seq: row.seq,                       // numeric — keys the runEvents ring
  event: 'run.event',
  payload: {
    event: <mapped inner>,            // 'run.started' | 'run.paused' | 'run.resumed' | 'run.completed'
    payload: { state, status },       // runRowsFromFrame reads this for status upsert
    seq: row.seq
  }
}
```

Inner-event mapping from Runyard's `run_events.type` / run status:
`run.started`/`run.assigned` while non-terminal → `run.started`;
`run.succeeded` → `run.completed` (state `ok`); `run.failed`/`run.cancelled`
→ `run.completed` (state `failed`); paused/resumed if/when those types exist.
`status` messages from `emitStatus` map the same way off `run.status`.

`runRowsFromFrame` then upserts the single `run` row's status; `eventRows` appends
each numeric-`seq` event row (ring-capped at 1024 by the package). Heartbeats are
ignored. **Reconnect/replay is supported** via `Last-Event-ID`/`afterSeq`.

---

## Frontend design

### Bundling (`bin/build-vendor.mjs`)

Add a third bundle, `public/vendor/gateway.bundle.js`, via a new
`entry-gateway.mjs` + `bundle()` call. The entry re-exports from the packages and
includes Runyard's own island components:

```js
// entry-gateway.mjs (generated)
export { createGatewayCollections, SyncProvider, SmithersGatewayProvider,
         useGatewayRuns, useGatewayRun, useGatewayRunEvents } from "@smithers-orchestrator/gateway-react";
export { SmithersGatewayClient, createSmithersGatewayTransport } from "@smithers-orchestrator/gateway-client";
// + Runyard-authored: makeTransport(), appGatewayCollections, RunDetailIsland, RunsListIsland
```

esbuild config deltas vs the reactflow bundle (the packages ship raw `.ts` with
explicit `./foo.ts` import specifiers — verified, both packages' `exports`
resolve to `./src/*.ts`):

- `loader: { ".ts": "ts", ".tsx": "tsx" }` (the single biggest difference)
- `jsx: "automatic"` (for Runyard's own `.tsx` islands; the SDK uses
  `createElement`, no JSX, so the SDK itself needs no JSX transform)
- keep `format: "esm"`, `bundle: true`, `target: ["es2020"]`,
  `define: { "process.env.NODE_ENV": '"production"' }`, `nodePaths`
- no worker/wasm/CSS (none of these packages ship any).

**Single-React / single-`@tanstack/db` is load-bearing** — a second React breaks
hooks; a second `@tanstack/db` makes `useLiveQuery` silently render nothing.
**The existing `reactflow.bundle.js` BUNDLES React in** (`entry-reactflow.mjs`
imports `react`/`react-dom` directly and exports them; the island reads
`const { React, ReactDOMClient } = reactflow`). So "share the existing React" is
NOT free. Two acceptable strategies (pick in Phase 0 smoke test):

1. **Reuse reactflow's React (preferred, zero-importmap):** mark
   `react`/`react-dom`/`react-dom/client` as esbuild `external` in the gateway
   bundle, and at runtime resolve them via the **already-loaded reactflow bundle's
   exports** rather than a bare import. Concretely: `entry-gateway.mjs` does NOT
   `import "react"`; instead the gateway bundle receives `React`/`ReactDOMClient`
   injected by `app.js` (which already holds them from `loadReactFlow()`), OR an
   importmap maps `react`/`react-dom` to the reactflow bundle's URL. One React,
   one `@tanstack/db` (inlined once into gateway.bundle.js).
2. **Bundle React into gateway.bundle.js and route ALL React through it:** make
   the gateway bundle the canonical React and have the reactflow island import
   React from the gateway bundle. Larger change to the reactflow path.

Validate the chosen strategy with the Phase 0 smoke test before any server work.

### New source (copy-from multi/smithers)

- `appGatewayCollections.ts` — copy the SHAPE of
  `smithers/apps/smithers/src/sync/appGatewayCollections.ts` (the clean,
  electric-free, persistence-free form, NOT multi's persistence-swapping Proxy):
  `makeTransport(): SyncTransport` returning the Runyard SSE adapter, then
  `createGatewayCollections({ client: makeTransport(), listGcTime: 4 * 60_000 })`
  ONCE as a module singleton. Omit `onAuthError` (cookie auth, no-op). NEVER touch
  `syncSource`/`electric`/`persistence`.
- `runyardTransport.ts` — the ~60-line `SyncTransport`: `rpc` switch
  (`listRuns`/`getRun` → existing REST + row mapping) and `stream`
  (EventSource → AsyncIterable, scope `streamRunEvents` only).
- `RunDetailIsland.tsx` — `useGatewayRun(runId)` (live status) +
  `useGatewayRunEvents(runId)` (live log), writing into the existing detail DOM.
- `RunsListIsland.tsx` (Phase 3) — `useGatewayRuns({})` +
  `useLocalModeRefetch`-style `setInterval(refetch, 4000)` (copy
  `multi/src/sync/useLocalModeRefetch.ts`, retune 2500 → 4000) + focus/visibility.

### Mount strategy (mirrors the existing ReactFlow island precedent)

The ReactFlow island precedent: `loadReactFlow()` (`app.js`) dynamic-imports the
vendor bundle, `mountReactFlowGraph` does `ReactDOMClient.createRoot(host)` +
`root.render(...)` into a host div inside `#content`.

**Run DETAIL (Phase 2):** `renderRunDetail` (`app.js:3248`) keeps rendering its
full server-HTML shell on first paint from the one-shot `api('/api/runs/:id')` —
so `header.run-banner[data-status]`, `.run-banner-status .status`,
`[data-run-section="log|artifacts|payload|meta"]`, `#panel-logs`, diagnostics ALL
exist before the island mounts (every e2e selector matches immediately, no
loading flash). Then:

1. dynamic-`import('/public/vendor/gateway.bundle.js')`
2. `createRoot` into a mount node inside the banner + `#panel-logs`
3. render `<SyncProvider client={appGatewayCollections}><RunDetailIsland runId=.../></SyncProvider>`

`RunDetailIsland` upserts the banner `data-status` + `.status` text from
`useGatewayRun` and appends new log rows into `#panel-logs` from
`useGatewayRunEvents`. The collections registry is the module singleton, reused
across mounts.

**Root teardown (first-class deliverable, fixes a pre-existing leak):** there is
NO `root.unmount()` anywhere in `app.js` today — the existing ReactFlow root
leaks across `hashchange`. Track every created root module-side and call
`root.unmount()` at the **top of `render()`** (`app.js:916`) before
`#content.innerHTML` is replaced. This fixes both the new island and the existing
ReactFlow leak.

**Feature flag + fallback:** gate the island behind a flag
(`window.__RUNYARD_LIVE` / a `?live=0` kill switch / a `settings` toggle). If the
flag is off OR `import('/public/vendor/gateway.bundle.js')` rejects, the detail
page keeps its existing vanilla shell and (Phase 1) a thin vanilla SSE/poll log
fallback — a bundle failure degrades to today's behavior, never a red detail test.

**Run LIST:** untouched in Phases 1-2 (`pollActiveRunProgress` stays byte-
identical, pinning the crown-jewel list tests). Phase 3 optionally swaps it for
`RunsListIsland` emitting the IDENTICAL `[data-run-progress]` `<ol>` strip via
`runProgressStrip`, refetch-driven at 4000ms.

### Polling removed

- Phase 2: the detail page's reliance on the `softRefreshDetail` hash-bounce is
  superseded by live SSE; the one-shot fetch stays only as first-paint + fallback.
- Phase 3 (optional): `pollActiveRunProgress`'s `setInterval` is replaced by
  `useGatewayRuns.refetch()` on the same 4000ms cadence (the `runs` collection
  has no server stream by design — it is refetch-driven).

---

## Phases (each independently shippable, each leaves all 23 e2e green)

### Phase 0 — De-risk the bundle (NO product change)

- Add the 4 deps. Extend `bin/build-vendor.mjs` with `entry-gateway.mjs` +
  `gateway.bundle.js`, `loader:{".ts":"ts",".tsx":"tsx"}`, `jsx:"automatic"`,
  and the chosen single-React strategy.
- Throwaway smoke: a tiny island that mounts `useGatewayRun` against a STUB
  transport emitting a fake frame, mounted on a scratch page; confirm
  `useLiveQuery` actually re-renders (proves single React + single `@tanstack/db`).
- **Verification:** `pnpm build:vendor` succeeds; the smoke island re-renders off
  the stub frame; `pnpm test:e2e` (23) unchanged — no app.js/server change yet.

### Phase 1 — Server stream + emitter + seq (NO frontend change)

- `seq` migration + `addRunEvent` sets `seq`; `listRunEvents(runId, {afterSeq})`.
- `src/runStream.js`; hook `addRunEvent` + `transitionRun`/`updateRun`.
- `GET /api/runs/:id/stream` (SSE, replay + subscribe + heartbeat + cleanup);
  extend `telegramSessionCanAccess` regex.
- **Verification:** unit/integration test that an SSE client receives replay then
  live appends with monotonic `id:` and resumes from `Last-Event-ID`. `pnpm test`
  green. `pnpm test:e2e` (23) green — frontend untouched, so list + detail behave
  exactly as today.

### Phase 2 — Live run DETAIL island (the win)

- `runyardTransport.ts`, `appGatewayCollections.ts`, `RunDetailIsland.tsx`.
- Wire into `renderRunDetail` behind the live flag; add `root.unmount()` at the
  top of `render()` (fixes the ReactFlow leak too).
- Detail page is now push-live for status + log; first paint still server-HTML.
- **Verification:** existing 23 e2e green (first-paint shell preserves every
  selector; `softRefreshDetail` still works because the shell re-renders; no
  `location.reload`). PLUS the NEW truly-live assertions (below) pass with the
  flag ON. Flag OFF → identical to Phase 1.

### Phase 3 (optional) — Live LIST + delete polling

- `RunsListIsland.tsx` + `useLocalModeRefetch` at 4000ms; replace
  `pollActiveRunProgress` emitting the identical strip HTML.
- Delete the old `setInterval` poll path last.
- **Verification:** 23 e2e green (the no-reload sentinel still passes —
  `refetch()` never reloads; the `[data-run-progress]` `<ol>` swap is byte-
  identical). New live-detail assertions still green.

---

## e2e gating

Each phase is gated on the existing 23 staying green, run after the change:

- **Phase 0** touches only the bundler + deps → the 23 are mechanically unaffected
  (no app.js/server change); run them to confirm the new bundle's presence doesn't
  perturb load.
- **Phase 1** touches only the server (additive SSE route + seq + emitter) → the
  list poll path and the detail one-shot fetch are byte-identical, so all 23 stay
  green; the new SSE route is exercised by a dedicated server test, not the 23.
- **Phase 2** preserves every selector via first-paint server-HTML and keeps
  `softRefreshDetail` working; `location.reload` is never called (EventSource/
  fetch don't reload), so `armNoReloadGuards`/`assertNoReloadHappened` stay
  satisfied. The island only upserts banner status + appends log rows in place.
- **Phase 3** keeps the `[data-run-progress]` `<ol>` swap and `runProgressStrip`
  output identical and the refetch cadence at 4000ms.

A regression in any phase is caught before shipping; the live layer is flag-gated
so it can ship dark and be toggled on after the 23 pass.

## NEW e2e tests to ADD

Add a `run-detail-live.spec.ts` (or a new block in `run-lifecycle-live.spec.ts`)
that proves the detail page is **genuinely live — NO `softRefreshDetail`, NO
hash-bounce, NO `page.reload()`** once Phase 2 lands (run with the live flag ON):

1. **Live status, no hash-bounce.** `page.goto('#runs/<id>')` with the run
   `queued`; `armNoReloadGuards`. Drive `queued → running` server-side via the
   fake runner. Assert `header.run-banner` flips to `data-status="running"` via
   `expect.poll` that **only reads the DOM** (no `softRefreshDetail` call inside
   the poll). Then drive to `succeeded`; assert the banner flips to
   `data-status="succeeded"` and `.run-banner-status .status` contains
   `succeeded` — again with no hash-bounce. `assertNoReloadHappened`.
2. **Live log append, no hash-bounce.** With the detail page open and armed, post
   a run event server-side (`runner.emit(runId, { type:'runner.progress',
   message: marker })`). Assert `[data-run-section="log"]` contains the marker via
   a DOM-only `expect.poll` (no `softRefreshDetail`). `assertNoReloadHappened`.
3. **Live output.** Complete the run with `outputs: { hello: { greeting: marker } }`;
   assert `[data-run-section="payload"]` contains the marker live (DOM-only poll).
4. **SSE resume.** Optional: simulate a dropped EventSource (close + reopen) and
   assert no duplicate log rows and no missed events (proves `afterSeq` replay).
5. **Flag-off parity.** With the live flag OFF, the existing
   `softRefreshDetail`-based assertions still pass (fallback is today's behavior).

The crucial difference from the existing detail tests: today's
`run-lifecycle-live.spec.ts` calls `softRefreshDetail(page, runId)` INSIDE the
`expect.poll` to force a `hashchange` re-render. The new assertions must NOT —
the DOM must update on its own, proving the SSE-driven island is live.

Also add a **contract smoke test** (unit, in `tests/`): construct
`createGatewayCollections({ client: stubTransport })`, feed one synthetic
`streamRunEvents` frame with `event:'run.event'`, `seq:1`,
`payload:{ event:'run.completed', payload:{ state:'ok' }, seq:1 }`, and assert the
`run` collection's status upserts and the `runEvents` collection gets a `seq:1`
row. This pins the frame contract against the installed `@0.24.x` so a silent
package change fails CI instead of rendering empty live data.

## Rollback / feature flag

- The entire live layer is behind a flag (`window.__RUNYARD_LIVE`, default
  configurable; a `?live=0` query kill switch; optionally a `settings` toggle).
- Flag OFF → `renderRunDetail` keeps its existing vanilla shell + one-shot fetch +
  (Phase 1) a thin vanilla SSE/poll log fallback; `pollActiveRunProgress` stays.
  This is byte-identical to today's behavior.
- The island mount is wrapped in `try/catch`; an `import()` rejection or a mount
  error falls back to the vanilla shell — a bundle problem degrades, never reds a
  test.
- Phases are independently revertible: Phase 1 (server) is additive and inert
  without a consumer; reverting Phase 2/3 (frontend) leaves the server stream
  unused but harmless. `git revert` of any single phase leaves the 23 green.
- The `seq` column + backfill is forward-only and additive (existing queries
  ignore it); no rollback needed for the migration.

## Kill criteria (validate Phase 0 FIRST)

The chosen approach is WRONG if any hold:

1. **Single-React / single-`@tanstack/db` can't be satisfied cheaply.** The
   reactflow bundle inlines React (verified); sharing it requires external +
   injection/importmap, or accepting a second React (which silently renders
   NOTHING via `useLiveQuery`). If the Phase 0 smoke island can't re-render off a
   stub frame with one shared React, pivot to dropping `gateway-client` (smaller
   raw-`.ts` surface to bundle) or to a dependency-free EventSource → vanilla-DOM
   patch.
2. **esbuild can't bundle gateway-react's raw `.ts`** (explicit `./foo.ts`
   specifiers). If the package's exports don't resolve through esbuild even with
   the `.ts` loader, the "reuse multi's consumer layer" premise collapses.
3. **The frame contract churns across `0.24.x`** (`frame.payload.event` names,
   numeric-`seq` keying, the run-has-stream/runs-refetch split). The contract
   smoke test must guard this; pin `^0.24.2`.
4. **Product wants the devtools run TREE.** All variants here skip
   `useGatewayRunTree`. Confirm with the user that status + log live detail is the
   target, not a node graph (which Runyard's flat `run_events` can't cheaply
   back).

## Open forks for the user

1. **Keep `gateway-client` as a dep, or drop it?** This plan keeps it for parity
   with the "mirror multi / gateway-client + TanStack DB" intent, but routes
   traffic through a Runyard SSE adapter, not the gateway WS client — so
   `gateway-client` is largely a parity/type dependency. Dropping it entirely
   ("Native, no gateway-client") removes all gateway WS-wire version coupling and
   shrinks the raw-`.ts` bundle surface, at the cost of diverging further from
   multi's declared dependency set. **Recommend: keep it now for parity; revisit
   after Phase 0 proves the bundle.**
2. **SSE vs WS.** Plan picks SSE (cookie auth free, no new dep, CSP unchanged,
   `Last-Event-ID` resume). WS would also work under `connect-src 'self'` but adds
   `ws` + handshake/framing for no gain. **Confirm SSE is acceptable.**
3. **Single-React strategy** (Phase 0 fork): reuse reactflow's bundled React via
   external+injection/importmap, vs. make the gateway bundle the canonical React
   and re-route the reactflow island through it. The smoke test decides.
4. **Live LIST now or later (Phase 3).** Migrate the list to `useGatewayRuns` +
   `useLocalModeRefetch`, or leave the proven `pollActiveRunProgress` poll
   indefinitely (it's already 4000ms and e2e-green)? The list gains no liveness
   the poll lacks (no server stream by design). **Recommend: defer / make optional.**
5. **Devtools run tree.** Out of scope here. Adopt `useGatewayRunTree` + a
   `getDevToolsSnapshot`/`streamDevTools` surface later, or never? Runyard's flat
   `run_events` make it a meaningful separate effort.
6. **Live-flag default.** Ship the live detail island ON by default after the 23 +
   new assertions pass, or ship it dark (default OFF) and flip it on in a
   follow-up? **Recommend: ship dark, flip after a green soak.**
