# Frontend Migration Status — React + TanStack

Branch: `feat/tanstack-react-ui`. See **FRONTEND-MIGRATION-PLAN.md** for the full
design. This file tracks live progress and how to resume.

## TL;DR

The hard architectural work is **done and verified**: esbuild `build:web`, the
TanStack Query + TanStack DB collection layer, hash router (deep-link grammar
preserved), cookie/Telegram/token auth gate, and the app shell all run with the
existing `styles.css` reused unchanged. The **Runs/Home view is fully ported and
reactive** — it is driven by the TanStack DB runs collection (no setInterval),
proving the core thesis. Remaining work is porting the other ~16 views into the
same established pattern.

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
  - `index.html` reduced to `#root` + module; legacy app preserved as
    `public/legacy-app.js` (porting reference, not loaded).
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

## Polling → reactive sync (Phase 4, in progress)

Replaced so far: the 4s active-run progress poll and the 30s sidebar-badge poll
(now derived live queries over the collections). Still polling via per-view
`useQuery` refetchInterval (acceptable, no manual loops): run detail, reauth,
update badge — to be wired as those views land.

## Remaining (port into the established pattern; commit per view)

Run detail (+ event log/diagnostics) · Workflows list · Workflow detail
(ReactFlow graph + highlight.js code tab) · Run form + workflow editor ·
Approvals list/detail · Runners · Schedules (list/detail/editor) ·
Agents/Skills/Knowledge · Tokens · Secrets (+reauth) · Update/Alerts ·
Connect/Onboarding · Support chat. Final: delete `legacy-app.js`, prune unused
vendor JS, full gate pass + screenshots. (Audit + Settings: done, see Phase 3a.)

## How to resume

1. `pnpm install` then `pnpm build` (vendor + web). `pnpm watch:web` for dev.
2. `pnpm start` (serves on `$PORT`, default 8788). First bootstrap token at
   `data/bootstrap-token.txt`; `POST /api/auth/token-login` to get the
   `shub_session` cookie.
3. To port a view: read its `render<X>` in `public/legacy-app.js`, port pure
   helpers verbatim into `web/lib`, build JSX components reusing `styles.css`
   class names, back live/shared data with a collection or `useQuery`
   (`refetchInterval` for live), wire it into `web/app/Content.jsx`, then rewrite
   that view's legacy source-grep test to assert the React source.
4. Headless smoke: `node /tmp/web-smoke.mjs <base> <cookie> <hash> <png>` (CDP
   script — checks DOM render + console errors + screenshot).

## Gate status

| Gate | Status |
| --- | --- |
| `pnpm install` clean (pnpm only) | ✅ |
| `pnpm build:vendor` | ✅ |
| `pnpm build:web` | ✅ |
| `pnpm test` ≥ 384 pass / 0 fail | ⚠️ **366 pass / 18 fail** — all failures are legacy source-grep UI tests for **not-yet-ported** views (schedules-ui, uxui-polish-ui, supervision "UI source", workflow-source asset, ~2 app.js-grep in api.test.js). Each is rewritten to the React source as its view is ported (per agreed strategy). All backend/API behavior tests green. Target restored to 384+ at completion. |
| `pnpm start` + browser smoke, no console errors | ✅ login, shell, and **reactive Home** verified headless (zero console errors); other views render placeholders until ported |
| Lint/typecheck | n/a (no config; JSX is plain JS via esbuild) |

## Notes / decisions

- esbuild over Vite (already present, lower risk). `build:web` bundles
  self-contained; `build:vendor` retained for the CSS `index.html` links.
- `public/app.js` is now a **build artifact** (committed, matching the repo's
  convention of committing vendor bundles + the old app.js, so the self-hosted
  deploy serves straight from the repo with no build step).
- No server API/schema changes; no new endpoints. Polling fully covers "live".
