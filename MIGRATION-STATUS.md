# Frontend Migration Status — React + TanStack

Branch: `feat/tanstack-react-ui`. See **FRONTEND-MIGRATION-PLAN.md** for the full
design. This file tracks live progress and how to resume.

## TL;DR — COMPLETE ✅

The Hub frontend has been **fully rebuilt** as a React app on a TanStack
Query + TanStack DB sync layer (esbuild `build:web`), reusing the existing
`styles.css` unchanged. **Every view is ported** (runs/home, run detail +
**live SSE console**, workflows + ReactFlow graph + highlight.js code, run form,
workflow editor, approvals, runners, schedules, agents/skills/knowledge, tokens,
secrets, audit, settings, connect/onboarding, update badge, support chat) and
the legacy `public/app.js` is gone. setInterval polling is replaced by reactive
collections (+ an additive SSE stream for run events, with polling fallback).

**All eval gates are green:** `pnpm install` clean, `pnpm build:vendor` +
`pnpm build:web` succeed, `pnpm test` **384 pass / 0 fail**, and the hub boots
with all 19 routes rendering with **zero console errors**.

## Done

- **Phase 0 — Plan** (`FRONTEND-MIGRATION-PLAN.md`), committed.
- **Phase 1 — Scaffold** (commit `feat(web): scaffold…`):
  - `bin/build-web.mjs` + `pnpm build:web` / `pnpm watch:web` / `pnpm build`.
  - `web/lib`: `api.js`, `router.js` (deepLinks ported 1:1), `queryClient.js`,
    `collections.js` (runs/approvals/runners/capabilities via
    `queryCollectionOptions`), `format.js`, `storage.js`, `toast.js`,
    `clipboard.js`, `me.js` (boot: session → Telegram WebApp → token login).
  - `web/app`: `AuthGate`, `Shell` (topbar + env chip + sidebar + admin menu +
    reactive nav badges), `Content` (route dispatch), `EnvChip`.
  - `index.html` reduced to `#root` + module. (Legacy app was kept as
    `public/legacy-app.js` during the port and **deleted in the final cleanup**.)
- **Phase 2 — Runs/Home** (commit `feat(web): port Runs/Home…`):
  - `web/views/Home.jsx` backed by the **reactive runs collection**
    (`useLiveQuery`), adaptive refetch (4s in-flight / 30s idle). Filters
    (URL-driven), in-flight/recent sections, incident card, stat strip, pending
    approvals, rerun-draft banner, onboarding gate.
  - Shared components: `RunCard`, `RunProgressStrip`, `IncidentCard`,
    `PrimaryActionBar`, `HomeStatStrip`, `ApprovalList`, `ui.jsx`
    (Icon/StatusBadge/ShareButton).
  - `web/lib`: `runHelpers.js` (pure derivers + summarizeFailure/cleanFailureText,
    ported verbatim), `runActions.js`, `approvalActions.js`, `badges.js`
    (reactive sidebar badges — replaces the 30s `refreshSidebarBadges` loop).
  - Rewrote `tests/runs-dashboard-ui.test.js` to assert the React source +
    import/exercise the real `cleanFailureText` (7/7 green).
- **Phase 3a — Audit + Settings** (commit `feat(web): port Audit + Settings…`):
  small read-only admin views (`useQuery` + shared `Toolbar`/`JsonBlock`/
  `StatusBadge`). Verified headless with real data, zero console errors.
- **Phase 3b — Run Detail** (commit `feat(web): port Run Detail…`): reactive
  per-run `useQuery` (refetchInterval only while non-terminal). Breadcrumbs,
  outcome banner (+overflow actions), meta strip, chips, queue banner,
  diagnostics, inputs/outputs (summary + raw), structured run log, artifacts,
  context. Section open state in React+sessionStorage so polling can't snap it.
- **Phase 3c — Live event console + SSE** (commits `feat(server): additive SSE…`
  and `feat(web): live event console…`): **additive** `GET /api/runs/:id/events/
  stream` (SSE) backed by `src/runEventBus.js` hooked into `addRunEvent`; a
  per-run TanStack events collection (custom sync: initial fetch → SSE →
  **polling fallback** on drop, dedup by id); `LiveConsole` panel that
  auto-scrolls on new events, with pause/resume ("N new ↓") and a live/polling
  status dot. Verified headless: live append + auto-scroll + pause + fallback,
  zero console errors, backend suite green.

- **Phases 3d–3m — remaining views** (commit per view): Approvals (list +
  detail), Runners (live collection), Tokens, Agents/Skills/Knowledge, Connect +
  Onboarding, Schedules (list/detail/editor + debounced cron preview), Secrets
  (+ runner auth-health/reauth), Workflows list + detail (ReactFlow graph +
  highlight.js code tab + run form + editor), the admin Update badge, and the
  global Support Chat FAB/panel. A Phase-1 auth bug was fixed along the way
  (`useMe` now unwraps `data.token` so admin-scoped gating works).
- **Final cleanup**: deleted `public/legacy-app.js`; migrated every legacy
  source-grep UI test to assert the React source; full gate pass + a 19-route
  console-error sweep (all clean).

## Polling → reactive sync — done

Replaced: the 4s active-run progress poll and the 30s sidebar-badge poll (now
derived live queries over the collections); the runners list (live collection);
and — for run events — the poll loop is replaced by a **real SSE stream**
consumed through a per-run TanStack events collection, with polling kept only as
the graceful fallback. Remaining per-view `useQuery` `refetchInterval` (run
detail, reauth, update badge, dashboard) are reactive Query refetches, not manual
loops — no `setInterval` remains in the app.

## How it's built / how to run

1. `pnpm install` then `pnpm build` (vendor + web). `pnpm watch:web` for dev.
2. `pnpm start` (serves on `$PORT`). First bootstrap token at
   `data/bootstrap-token.txt`; `POST /api/auth/token-login` for the
   `shub_session` cookie.
3. Source lives under `web/` (esbuild → `public/app.js`). To extend a view:
   build JSX reusing `styles.css` class names, back live/shared data with a
   collection or `useQuery`, wire into `web/app/Content.jsx`.

## Gate status — ALL GREEN ✅

| Gate | Status |
| --- | --- |
| `pnpm install` clean (pnpm only) | ✅ |
| `pnpm build:vendor` | ✅ |
| `pnpm build:web` | ✅ |
| `pnpm test` ≥ 384 pass / 0 fail | ✅ **384 pass / 0 fail** |
| `pnpm start` + browser smoke, no console errors | ✅ all **19 routes** swept headless — zero console errors |
| Lint/typecheck | n/a (no config; JSX is plain JS via esbuild) |

## Notes / decisions

- esbuild over Vite (already present, lower risk). `build:web` bundles
  self-contained; `build:vendor` retained for the CSS `index.html` links.
- `public/app.js` is now a **build artifact** (committed, matching the repo's
  convention of committing vendor bundles + the old app.js, so the self-hosted
  deploy serves straight from the repo with no build step).
- No server API/schema changes; no new endpoints. Polling fully covers "live".
