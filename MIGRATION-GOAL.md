# Goal: Rebuild the RunYard Hub frontend as React + TanStack

You are working in a dedicated git worktree on branch **`feat/tanstack-react-ui`** at
`/home/xiko/smithers-hub-worktrees/tanstack-react`. This is RunYard (package name
`smithers-hub`). **Do NOT touch the `main` worktree at `/home/xiko/smithers-hub`.**

## Context

The Hub backend is a Node/Express app (`src/server.js`) with its own SQLite DB and a REST API.
The current **frontend is a single hand-rolled vanilla-JS SPA**: `public/app.js` (~284KB) that
uses `document.querySelector` / `document.createElement` for DOM, `fetch()` for the API, and
`setInterval` polling for live data (runs, events, approvals, etc.). `public/index.html` loads
`app.js` as a module. esbuild already vendors `react`, `react-dom`, `@xyflow/react` (ReactFlow),
and `highlight.js` into `public/vendor/` via `bin/build-vendor.mjs` (`pnpm build:vendor`).

Upstream Smithems (the `smithers-orchestrator` engine) rebuilt its gateway sync SDK on **TanStack
DB** in 0.24/0.25 (`@smithers-orchestrator/gateway-react`: `useSyncQuery`, `useGatewayRunStream`,
`useGatewayRunTree`, etc.). We want the Hub's OWN frontend to adopt the same modern stack.

## What "switch to TanStack and React" means here

Rebuild the Hub frontend as a proper **React** application whose live-data/sync layer is built on
**TanStack** (TanStack Query + TanStack DB collections), replacing the manual `setInterval`
polling with reactive collections. This is a **frontend-only** migration:

- **Do NOT change the server's REST/WS API contract or the DB schema.** The React app consumes the
  exact same endpoints `app.js` uses today. If you find a real need for a new endpoint (e.g. a
  WebSocket/SSE stream for live run events to replace polling), treat it as optional/additive and
  flag it in the plan first — do not break existing endpoints.
- Keep Telegram WebApp auth and the magic-link/token auth flows working.
- Preserve every existing view and feature (home, capabilities/workflows, runs list, run detail
  with the ReactFlow graph, events/logs, approvals, agents, skills, runners, secrets, alerts,
  update-status, docs/landing). Inventory them from `app.js` before porting.

## Required approach — incremental, never big-bang

1. **Investigate first.** Read `public/app.js`, `public/index.html`, `src/server.js` routes, and
   `bin/build-vendor.mjs`. Produce **`FRONTEND-MIGRATION-PLAN.md`** at the repo root: a full view/
   feature inventory, the API endpoints each view uses, the target component tree, the TanStack
   collection/query design (what's polled vs streamed), the build-pipeline plan, and a phased port
   order. Commit this plan first.
2. **Scaffold the build.** Set up React + TanStack Query (`@tanstack/react-query`) + TanStack DB
   (`@tanstack/react-db` / `@tanstack/db`) with esbuild (preferred — it's already here) or Vite if
   clearly better. Wire it so `pnpm build:web` produces a bundle that `index.html` loads, and the
   Express static serving still works. Use pnpm only (never npm). Keep ReactFlow + highlight.js
   working through the new build.
3. **Port view-by-view.** Migrate one view at a time into React components backed by TanStack
   collections. Keep the app building and runnable after every phase. Commit after each ported
   view with a clear message. Delete the corresponding vanilla code from `app.js` only once its
   React replacement is verified, so the app is never half-broken.
4. **Replace polling with reactive sync.** Model runs/events/approvals/etc. as TanStack DB
   collections; components subscribe reactively. Centralize the `api()` fetch wrapper.

## Evaluation gates — loop until all green before declaring done

- `pnpm install` clean (pnpm only).
- `pnpm build:vendor` and the new `pnpm build:web` both succeed with no errors.
- Backend suite stays green: `pnpm test` (currently 384 passing — must remain 384+ passing, 0 fail).
- Start the hub locally (`pnpm start`) and smoke-test in a browser/headless: the app loads, the
  main views render, **no console errors**, and live data (a runs list / run detail) updates
  reactively. Use the agent-browser/browser tooling to verify and screenshot key views.
- Lint/typecheck if config exists.

Document any gate you cannot pass and why, rather than skipping silently.

## Working rules

- Commit frequently to `feat/tanstack-react-ui` with descriptive messages. Do NOT merge to main,
  do NOT tag, do NOT deploy — leave that to Fran/Ocean.
- This is a large task. Pace yourself: plan → scaffold → port incrementally → verify. It's fine to
  land it across many commits.
- If you hit a genuine architectural fork (e.g. esbuild vs Vite, polling vs new WS endpoint),
  pick the lower-risk option, document the choice in the plan, and keep moving.
- When you stop, leave a short `MIGRATION-STATUS.md` at repo root: what's done, what's left, how to
  resume, and current gate status.
