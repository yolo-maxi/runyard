# Runyard Hub Frontend Migration Plan — Vanilla JS → React + TanStack

**Branch:** `feat/tanstack-react-ui` (worktree `/home/xiko/smithers-hub-worktrees/tanstack-react`)
**Status:** Plan (Phase 0). Investigation complete; scaffolding next.

## 1. Goal & constraints

Rebuild the Hub's hand-rolled vanilla-JS SPA (`public/app.js`, 284 KB / 5869 lines)
as a **React** application whose live-data layer is **TanStack** (TanStack Query +
TanStack DB collections), replacing `setInterval` polling with reactive collections.

**Hard constraints (from the brief):**
- **Frontend-only.** Do **not** change the server REST API contract or DB schema. The
  React app consumes the exact endpoints `app.js` uses today.
- Keep **Telegram WebApp auth** and **token/magic-link** auth working.
- Preserve **every** view and feature (inventory below).
- New endpoints only if truly needed (e.g. a stream to replace polling) — **additive,
  flagged first, never breaking**. *Decision: none needed — see §6.*
- pnpm only. Keep ReactFlow + highlight.js working through the new build.
- Backend suite stays green (`pnpm test`, currently **384 passing / 0 fail** — verified).

## 2. Current architecture (as-found)

- **Entry:** `public/index.html` loads `<script type="module" src="/public/app.js">`.
  It also references `/public/styles.css`, `/public/vendor/highlight.css`,
  `/public/vendor/reactflow.css`, and the Telegram WebApp SDK via `<script>`.
- **Vendoring:** `bin/build-vendor.mjs` (`pnpm build:vendor`) uses **esbuild** to bundle
  `react`, `react-dom`, `@xyflow/react` → `public/vendor/reactflow.bundle.js` and
  `highlight.js` → `public/vendor/highlight.bundle.js`, plus copies their CSS. Today
  `app.js` mounts the ReactFlow graph via `React.createElement` pulled from that bundle.
- **Router:** hash-based. `deepLinks.parse()` (app.js:89) turns `location.hash` into
  `{ segments, params, view }`; `render()` (app.js:1107) dispatches per `route.view`;
  `hashchange` (app.js:5097) re-renders. **Deep links are a documented product feature
  ("every URL in the Hub is shareable") — the hash route grammar must be preserved.**
- **API wrapper** `api(path, options)` (app.js:11): thin `fetch` wrapper, JSON in/out,
  relative URLs, throws `Error(data.error || HTTP <status>)` on non-2xx. **Auth is
  cookie-based** (`shub_session`, HTTP-only) — the client stores **no** token; the
  browser attaches the cookie automatically. Telegram WebApp + token-login endpoints
  mint that cookie.
- **Server (`src/server.js`):** Express. Serves `/` → `landing.html`, `/app` →
  `index.html`, `/docs` → `docs.html`, `/public/*` → `express.static`. ~70 routes, all
  JSON or text. **No WebSocket, no SSE** — every "live" surface is client polling.

### 2.1 Polling loops to replace with reactive sync

| Loop (app.js) | Interval | Refreshes | Target |
| --- | --- | --- | --- |
| `refreshSidebarBadges` (1067) | 30 s | `/api/runs?limit=100`, `/api/runners`, `/api/dashboard` | derived live query over collections |
| `refreshUpdateBadge` (1072) | 60 s | `/api/update-status` (admin) | `useQuery` refetchInterval 60 s |
| active-run progress (1517/2005) | 4 s | `/api/runs/<id>` per active run | runs collection refetch (adaptive) |
| run-detail live duration (5120) | 1 s | none (clock tick) | local `useNow()` hook |
| reauth poll (4688) | 2 s, cap 5.5 m | `/api/runs/<runId>` for `reauth.verification` | scoped `useQuery` refetchInterval |
| support chat status (5341) | once | `/api/chat/status` | `useQuery` |

## 3. View / feature inventory (must all be preserved)

Routes are hash segments; `view` is the first segment normalized.

| # | View | Hash route | Primary endpoints | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Home / Runs list** | `#runs` `#home` `#dashboard` | `GET /api/runs`, `/api/dashboard`, `/api/runners`, `/api/capabilities`, `/api/artifacts` | filters (status/q/since/cursor), in-flight vs recent, pending-approvals strip, incident card, onboarding gate, rerun-draft banner; 4 s active-run polling |
| 2 | **Run detail** | `#runs/<id>` `/logs` `/artifacts` | `GET /api/runs/:id`, `POST .../cancel`, `POST .../rerun` | status banner, meta block, inputs/outputs, event log (search, hide-routine, wrap), artifacts, diagnostics; live duration |
| 3 | **Workflows / Capabilities** | `#workflows` `#capabilities` | `GET /api/capabilities`, `/api/runs?limit=200` | cards w/ last-run + success rate; onboarding card |
| 4 | **Workflow detail** | `#workflows/<slug>[/sub]` | `GET /api/capabilities`, `/api/capabilities/:id/source`, `/api/runs` | tabs: overview / runs / **code** (highlight.js) / **graph** (ReactFlow) |
| 5 | **Workflow run form** | `#workflows/<slug>/run` `/edit` | `POST /api/capabilities/:id/run`, `POST /api/runs/:id/rerun`, `GET /api/repo-options` | schema-driven form, repo picker, exec mode, approval override; sessionStorage draft |
| 6 | **Workflow editor** | modal in workflow detail | `POST /api/capabilities`, `PATCH /api/capabilities/:id` | name/slug/category/tags/approval policy, JSON schema editor |
| 7 | **Approvals list** | `#approvals` | `GET /api/approvals`, `POST .../{approve,reject,request-changes}` | inline decisions; badge |
| 8 | **Approval detail** | `#approvals/<id>` | `GET /api/approvals/:id`, decision POSTs | context, payload, decision form |
| 9 | **Agents / Skills / Knowledge** | `#agents[/<tab>[/<slug>]]` | `GET/POST/PATCH /api/{agents,skills,knowledge}`, `GET /api/capabilities` | tabbed grid, editor panel, "used by" backlinks |
| 10 | **Tokens** | `#tokens` | `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | create (scopes/expiry), reveal+copy, revoke |
| 11 | **Runners** | `#runners` | `GET /api/runners` | pool summary, online/offline tables, heartbeat freshness, expandable detail |
| 12 | **Schedules list** | `#schedules` | `GET /api/schedules`, run-now/enable/disable/delete | cron/once cards |
| 13 | **Schedule detail** | `#schedules/<id>` | `GET /api/schedules/:id` | next-runs preview |
| 14 | **Schedule editor** | modal | `POST /api/schedules`, `PATCH`, `GET /api/schedules/preview` | cron preview (debounced) |
| 15 | **Secrets** | `#secrets` (admin) | `GET /api/secrets`, `PUT/DELETE /api/secrets/:key`, `GET /api/runners`, `POST /api/capabilities/reauth-cli/run` | runner auth-health, reauth poll (2 s) |
| 16 | **Connect / Onboarding** | `#connect` `#onboarding` | `POST /api/tokens`, `GET /api/runners`, `POST /api/capabilities/:id/run` | setup cards; 3-step wizard w/ runner-heartbeat poll |
| 17 | **Audit** | `#audit` (admin) | `GET /api/audit` | table |
| 18 | **Settings** | `#settings` (admin) | `GET /api/setup` | deployment JSON, Telegram status |
| 19 | **Update badge / Alerts** | topbar + `#alerts`-ish | `GET /api/update-status`, `POST /api/update/apply`, `GET /api/alerts` | admin |
| 20 | **Support chat** | global FAB + panel | `GET /api/chat/status`, `POST /api/chat` | multi-tab, localStorage, Ctrl+/, context-aware |
| 21 | **Login / auth gate** | `#login` fallback | `GET /api/me`, `POST /api/auth/{token-login,telegram-webapp,logout}` | cookie session; Telegram WebApp initData first, token fallback |
| 22 | **Env chip / topbar** | header | `GET /api/setup`, `GET /api/version` | connected-hub chip |

Static pages `landing.html`, `docs.html` are **server-rendered HTML and stay as-is**
(out of scope — not part of the SPA). The SPA lives at `/app`.

## 4. Target architecture

### 4.1 Build pipeline — **esbuild** (chosen over Vite)

**Decision:** extend the existing esbuild setup rather than introduce Vite. esbuild is
already a dependency, already drives `build:vendor`, the team knows it, and it needs no
dev-server/HMR contract change with Express. Lower risk; documented per the brief's
"architectural fork → pick lower-risk, document, move on."

- New `bin/build-web.mjs` + `pnpm build:web`: esbuild bundles the React app
  (`web/main.jsx` entry) **self-contained** — React, ReactDOM, `@xyflow/react`,
  highlight.js, and all TanStack packages bundled in — to `public/app.js`
  (the file `index.html` already loads). JSX via esbuild `loader: jsx`,
  `jsx: automatic`. `--watch` mode for dev.
- **Why self-contained, not externalized to `vendor/`:** the vendor bundle exposes a
  single module with `{React, ReactDOM, ReactFlow}` named exports — it can't satisfy
  bare `import {useState} from "react"` via import maps without friction. Bundling once
  in `build:web` avoids shipping React twice and keeps one source of truth. Once
  `app.js` is the React bundle, `vendor/reactflow.bundle.js` is no longer loaded at
  runtime.
- **`build:vendor` stays** — `index.html` still links `vendor/reactflow.css` and
  `vendor/highlight.css`; those copies are produced by `build:vendor`. We keep running
  it for CSS. (The now-unused vendor JS bundles can be pruned in the final cleanup
  phase, optional.)
- Output stays plain ES module served by `express.static` — **no server change**.
- `package.json`: add `@tanstack/react-query`, `@tanstack/react-db`, `@tanstack/db`,
  `@tanstack/query-db-collection` to devDependencies (bundled, so dev is fine).

### 4.2 Source layout (`web/`)

```
web/
  main.jsx                 # mount, providers (QueryClient, collections), AuthGate
  lib/
    api.js                 # centralized api() fetch wrapper (cookie auth, JSON)
    router.js              # useHashRoute() — ports deepLinks.parse grammar exactly
    collections.js         # TanStack DB collections (runs, approvals, runners, caps)
    queryClient.js         # QueryClient config (staleness, retry)
    format.js              # duration/time/status helpers ported from app.js
    storage.js             # useLocalStorage / useSessionStorage hooks
  app/
    Shell.jsx              # topbar, sidebar, content outlet, badges
    AuthGate.jsx           # /api/me → Telegram WebApp → token login
    SupportChat.jsx        # global FAB + panel
  views/
    Home.jsx  RunDetail.jsx  Workflows.jsx  WorkflowDetail.jsx
    WorkflowGraph.jsx (ReactFlow)  RunForm.jsx  Approvals.jsx  ApprovalDetail.jsx
    Agents.jsx  Tokens.jsx  Runners.jsx  Schedules.jsx  ScheduleDetail.jsx
    Secrets.jsx  Connect.jsx  Onboarding.jsx  Audit.jsx  Settings.jsx
  components/               # shared: StatusBadge, CodeBlock(highlight), JsonEditor, Modal, …
```

### 4.3 Routing

Keep **hash routing** to preserve shareable deep links. Port `deepLinks.parse` into
`web/lib/router.js` as `useHashRoute()` returning `{ view, segments, params }` and a
`navigate(hash)` helper. No `react-router`/TanStack Router dependency — the existing
grammar is small and bespoke; re-implementing it 1:1 is lower risk than adapting a
router to match it. (Revisit only if it gets unwieldy.)

### 4.4 Data layer — TanStack Query + TanStack DB

**Pattern:** back **shared, cross-view, live** entities with **TanStack DB collections**
via `@tanstack/query-db-collection`'s `queryCollectionOptions` (a collection whose sync
source is a TanStack Query, giving us polling + reactive `useLiveQuery`). Use plain
`useQuery` for **on-demand, single-view, non-shared** reads.

**Collections** (live, shared across views + sidebar badges):

| Collection | Source | Refetch | Consumers |
| --- | --- | --- | --- |
| `runs` | `GET /api/runs?limit=200` | adaptive: 4 s if any non-terminal run, else 30 s | Home, Workflows, badges |
| `approvals` | `GET /api/approvals` | 30 s | Approvals, badges |
| `runners` | `GET /api/runners` | 30 s | Runners, Home, Secrets, badges |
| `capabilities` | `GET /api/capabilities` | on focus / 60 s | Workflows, Agents, forms |
| `dashboard` | `GET /api/dashboard` | 30 s | Home, badges |

Sidebar badges become a **derived `useLiveQuery`** over `runs`/`approvals`/`runners`
(failures 24 h, offline runners, pending approvals) — no separate poll loop.

**`useQuery` (on-demand, with `refetchInterval` where live):**
- `runs/:id` detail — refetchInterval 4 s while run non-terminal, else off.
- `capabilities/:id/source` (graph+code), `repo-options` (cached), `schedules[/:id]`,
  `schedules/preview` (debounced), `agents`/`skills`/`knowledge`, `tokens`, `secrets`,
  `audit`, `setup`, `version`, `update-status` (60 s, admin), `alerts`, `chat/status`.

**Mutations** = `useMutation`; on success, `invalidate`/refetch the relevant collection
or query (e.g. cancel/rerun → `runs` + `runs/:id`; approve → `approvals`). Optimistic
updates where the old app did them (approvals badge clear).

Collection keys: entity `id` (runs, approvals, runners, schedules, tokens) or `slug`
(capabilities, agents, skills, knowledge, secrets key).

### 4.5 Auth

Port the exact boot sequence into `AuthGate.jsx`:
1. `GET /api/me`. If ok → authenticated.
2. Else if `window.Telegram?.WebApp?.initData` → `POST /api/auth/telegram-webapp`, retry `/api/me`.
3. Else render token-login form → `POST /api/auth/token-login` → reload/refetch `/api/me`.
4. Logout → `POST /api/auth/logout` → reset QueryClient + reload.

Cookie session is unchanged; `api()` keeps `credentials` default (same-origin cookie).
`/api/me` result is the source of `me` (scopes drive admin-only views).

## 5. Phased port order (commit after each; app builds & runs every phase)

> **Incremental strategy note.** The legacy SPA is a single module, so a literal
> "half vanilla / half React in one running page" isn't feasible. Instead: from Phase 1
> on, `index.html` loads the **new React bundle**, which is coherent and builds/runs at
> every commit. Un-ported views render a clear **placeholder panel** (title + "porting
> in progress" + working nav), so the app is **never broken**, only progressively more
> complete. `public/app.js`'s legacy source is preserved on disk as the porting
> reference (renamed `public/legacy-app.js`, not loaded) and deleted in the final phase
> once all views are verified — satisfying "delete vanilla only once replacement
> verified." This is the documented lower-risk reading of the brief's incremental rule.

- **Phase 0 — Plan** (this file). Commit. ✅ first.
- **Phase 1 — Scaffold.** Add deps; `bin/build-web.mjs` + `pnpm build:web`; `web/main.jsx`
  with QueryClient + collections providers; `useHashRoute`; `api.js`; `Shell` (topbar +
  sidebar + env chip + outlet) with placeholder views; `AuthGate`. Rename legacy
  `app.js`→`legacy-app.js`; point `index.html` at the new bundle. **Gate:** builds,
  loads, auth works, no console errors.
- **Phase 2 — Runs (home).** Runs collection + Home view (filters, sections, badges,
  pending-approvals strip, incident card). Adaptive polling replaces 4 s loop.
- **Phase 3 — Run detail.** `runs/:id` query, event log (highlight, search, hide-routine,
  wrap), artifacts, diagnostics, cancel/rerun mutations, live duration hook.
- **Phase 4 — Workflows + detail + ReactFlow graph + code tab.** Capabilities collection;
  `capabilities/:id/source`; ReactFlow `WorkflowGraph`; highlight code tab.
- **Phase 5 — Run form + workflow editor.** Schema-driven form, repo picker, exec mode,
  draft persistence; capability upsert mutations.
- **Phase 6 — Approvals** (list + detail + decisions; reactive badge).
- **Phase 7 — Runners** (pool, heartbeat freshness, expandable rows).
- **Phase 8 — Schedules** (list, detail, editor w/ cron preview).
- **Phase 9 — Agents / Skills / Knowledge** (tabbed, editor, backlinks).
- **Phase 10 — Admin: Tokens, Secrets (+reauth poll), Audit, Settings, Update/Alerts.**
- **Phase 11 — Connect / Onboarding wizard.**
- **Phase 12 — Support chat** (FAB, tabs, localStorage, Ctrl+/, context payload).
- **Phase 13 — Cleanup & gates.** Delete `legacy-app.js`; prune unused vendor JS;
  full gate pass; browser smoke + screenshots; `MIGRATION-STATUS.md`.

## 6. New endpoints?

The migration itself needs **none** — polling covers "live" via Query
`refetchInterval` / collection sync, and all existing endpoints are kept
byte-for-byte.

**Added (additive, by request):** `GET /api/runs/:id/events/stream` — a
Server-Sent Events stream that pushes run events as they are persisted, powering
the live event console in Run Detail. It is purely additive: no existing REST
endpoint, schema, or response shape changed. Server side it is a tiny in-process
pub/sub (`src/runEventBus.js`) hooked into the single event-write path
(`addRunEvent`); the client consumes it through a TanStack events collection and
**falls back to polling** `/api/runs/:id/events` if the stream drops or SSE is
unavailable. See Phase 3c.

## 7. Evaluation gates (loop until all green)

1. `pnpm install` clean (pnpm only). ✅ baseline
2. `pnpm build:vendor` + `pnpm build:web` succeed, no errors. (build:web new)
3. `pnpm test` ≥ 384 passing, 0 fail. ✅ baseline 384/0
4. `pnpm start`, browser/headless smoke: app loads, main views render, **no console
   errors**, live data (runs list / run detail) updates reactively. Screenshot key views.
5. Lint/typecheck if config exists (none currently; JSX is plain JS — add only if needed).

Any gate that can't pass gets documented in `MIGRATION-STATUS.md`, not skipped silently.

## 8. Risks & mitigations

- **Deep-link grammar drift** → port `deepLinks.parse` verbatim; add a tiny unit check.
- **React duplication / bundle bloat** → single self-contained `build:web`; vendor JS
  unloaded.
- **CSP** → server already allows self-hosted scripts/styles; bundle is same-origin, no
  CDN, no inline — compatible.
- **Telegram WebApp** → SDK stays a plain `<script>` in `index.html`; React reads
  `window.Telegram` at boot only.
- **Large surface** → strict phase order, placeholder fallback keeps app runnable, commit
  per phase.
