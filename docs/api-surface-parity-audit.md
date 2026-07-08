# API-First Product Surface Audit — UI ↔ API ↔ MCP Parity

Date: 2026-07-08 · Base: `main` @ v0.3.10 · Status: implemented (see "What changed")

## The invariant

> The Runyard web app is an ordinary API client. If the UI displays data or
> exposes an action, that data/action is available through the HTTP API and
> discoverable through MCP. A third-party client built only on
> `/openapi.json` + the MCP tool list can rebuild the app experience
> losslessly.

This audit maps every app surface to its API endpoint(s) and MCP tool(s),
records the gaps found, and describes the structural mechanism that now
prevents drift. It supersedes the parity sections (§8) of
`specs/product-surface-audit.md` (2026-07-04); several of that audit's
findings had already been fixed by PRs #12–#18 and are re-verified here.

## Verdict before changes

The UI was already an honest API client at the transport level:

- `public/index.html` is a static shell — no server-injected globals, no
  `window.__DATA__`, no SSR values. The app hydrates entirely from `/api/*`.
- The browser session cookie (`shub_session`) is the signed access-token
  string; the server unsigns it and runs the same `authenticateToken` as
  Bearer auth (`src/authRoutes.js:66`, `src/authMiddleware.js:22`). A session
  has exactly the token's scopes — no extra power. Telegram WebApp sessions
  are *narrower* (`approvals` scope only).
- One streaming channel exists (SSE `GET /api/runs/:id/events/stream`) with a
  documented polling equivalent. No WebSockets, no privileged transport.

The real parity failures were in the **discovery surfaces**: ~13 endpoints
the UI uses were missing from `/openapi.json`, and several UI-visible
data/actions had no MCP tool. Those are fixed; the remaining exemptions are
deliberate and listed at the end.

## What changed (the structural mechanism)

1. **`src/apiSurface.js`** — a declarative registry of every HTTP route:
   method, path, handler, auth, scopes, rate limits, OpenAPI summary, MCP
   tool mapping (or a written `mcpExempt` reason), and whether the web app
   uses it. This is now the only place a route can be added.
2. **`src/serverRoutes.js`** registers Express routes by interpreting the
   registry, so the route table cannot drift from the registry by
   construction.
3. **`/openapi.json` is generated** from the registry
   (`openApiPathsFromSurface()` in `src/discoveryDocs.js`) — 85 documented
   paths, up from ~40 hand-written ones.
4. **`src/mcpTools.js`** — the MCP tool definitions extracted into a
   side-effect-free module shared by the MCP server and the tests. 85 tools
   (14 added by this audit).
5. **`tests/api-surface.test.js`** fails the build when:
   - a registered route is missing from the registry or vice versa (including
     middleware/scope drift, checked per route);
   - a registry operation has neither an MCP tool nor a written exemption;
   - an MCP tool doesn't map back to any API operation (orphan tool);
   - `mcp.js` advertises a tool its dispatcher can't call;
   - the menu payload / `llms.txt` advertise unknown tools;
   - `openapi.json` is missing any `/api` operation;
   - **any file in `web/` calls an endpoint not in the registry** (static
     scan of `/api/...` literals, template prefixes included).

Adding a UI feature that needs new data therefore forces: registry entry →
scopes + OpenAPI summary + MCP decision, all in one diff, enforced by tests.

## Gaps found and fixed

### Endpoints missing from `/openapi.json` (all now generated)

`/setup`, `/auth/token-login`, `/auth/telegram-webapp`, `/auth/logout`,
`/dashboard`, `/repo-options`, `/artifacts` (list/search),
`/runs/{id}/events/stream`, `/runs/{id}/log-summary`, `/runs/{id}/diagnostics`,
`/workflows/{id}/source`, `/workflows/{name}/versions`, `/runners` (list),
`/runners/{id}/heartbeat`, `/update-status`, `/update/apply`,
`/tokens/{id}` (revoke), `/agents/{slug}`, `/skills/{slug}`,
`/knowledge/{slug}` (updates), `/workflow-bundles` family,
`/capabilities/*` legacy aliases (marked `deprecated`), `/version`.

### UI data/actions that had no MCP tool (tools added)

| UI surface | Endpoint | New MCP tool |
|---|---|---|
| Home dashboard header | `GET /api/dashboard` | `get_dashboard` |
| Workflow source-of-truth (bundles) | `GET /api/workflow-bundles`, `GET /api/workflow-bundles/:id`, `POST /api/workflow-bundles` | `list_workflow_bundles`, `get_workflow_bundle`, `publish_workflow_bundle` |
| Agents/Skills/Knowledge editors (admin) | `POST/PATCH /api/{agents,skills,knowledge}[/:slug]` | `create_agent`, `update_agent`, `create_skill`, `update_skill`, `create_knowledge`, `update_knowledge` |
| Update badge + Apply (admin) | `GET /api/update-status`, `POST /api/update/apply` | `get_update_status`, `apply_update` |
| Assistant chat | `GET /api/chat/status`, `POST /api/chat` | `get_assistant_status`, `ask_assistant` |

`llms.txt` and the authenticated menu now advertise the dashboard/bundle
tools, state that the full set is available over MCP `tools/list`, and state
the API-first guarantee explicitly.

## Page-by-page inventory (verified current at v0.3.10)

Every view, the data it shows, the actions it offers, and the API/MCP
coverage. "API" column lists what the UI actually calls; MCP names in
parentheses are the covering tools.

| Page / chrome | Data shown | Actions | API (MCP) |
|---|---|---|---|
| Auth gate | instance identity | token login | `GET /api/setup` (exempt: session bootstrap), `POST /api/auth/token-login` (exempt), `GET /api/me` (`whoami`) |
| Shell / sidebar | badge counts (failed runs, pending approvals, offline runners) — computed client-side from the same collections below | logout | `POST /api/auth/logout` (exempt) |
| Home / Runs | run list + filters, dashboard summary, artifacts index | filter/paginate (client), rerun-draft resume (sessionStorage) | `GET /api/runs` (`list_runs`), `GET /api/dashboard` (`get_dashboard`), `GET /api/artifacts` (`search_artifacts`) |
| Run detail | run, diagnostics, events, artifacts, log summary; live SSE console | rerun, edit-input rerun, cancel, promote, artifact preview/download | `GET /api/runs/:id` (`get_run_status`), `.../diagnostics` (`get_run_diagnostics`), `.../events` (`get_run_events`), `.../events/stream` (exempt: SSE, polling equivalent), `POST .../rerun` (`rerun_workflow_run`), `.../cancel` (`cancel_run`), `.../promote` (`promote_run`), `GET /api/artifacts/:id/download` (`download_artifact`) |
| Workflows list | catalog + per-card client-computed run stats | create from template (admin), run | `GET /api/workflows` (`list_workflows`/`search_workflows`), `POST /api/workflows` (`create_workflow`), `POST /api/workflows/:id/run` (`run_workflow`) |
| Workflow detail | definition, schema, source/graph tabs, recent runs | run (form w/ repo picker), edit (admin), delete (admin) | `GET /api/workflows/:id` (`describe_workflow`), `.../source` (`get_workflow_source`), `GET /api/repo-options` (`list_repo_options`), `PATCH`/`DELETE /api/workflows/:id` (`update_workflow`/`delete_workflow`) |
| Agents / Skills / Knowledge | catalog lists, backlinks | create/edit (admin, JSON editor) | `GET /api/{agents,skills,knowledge}` (`list_agents`/`list_skills`/`search_knowledge`), `POST`/`PATCH` (`create_*`/`update_*`) |
| Approvals | list + detail with ask/kind/consequences | approve / reject / request changes | `GET /api/approvals[/:id]` (`list_approvals`/`list_pending_approvals`/`get_approval`), `POST /api/approvals/:id/*` (`approve_run`/`reject_run`/`request_changes_run`) |
| Schedules | list, detail, cron preview | create/edit/enable/disable/delete/run-now (admin) | `GET/POST/PATCH/DELETE /api/schedules...` (`*_schedule` tools), `GET /api/schedules/preview` (`preview_schedule`), `POST .../run-now` (`run_schedule_now`) |
| Runners (admin nav) | runner list, heartbeat freshness (client clock), pool capacity | refresh | `GET /api/runners` (`list_runners`) — note: endpoint is any-auth; the admin gate is a UI navigation choice, not extra power |
| Connect & Tokens (admin) | token list; install/MCP/CLI snippets are client templating off `location.origin` | create/revoke token | `GET/POST /api/tokens` (`list_tokens`/`create_token`), `DELETE /api/tokens/:id` (`revoke_token`) |
| Settings & Secrets (admin) | deployment info, secret names, runner auth health | set/delete secret, reauth flows | `GET /api/setup` (exempt), `GET /api/secrets` (`list_secrets`), `PUT/DELETE /api/secrets/:key` (`set_secret`/`delete_secret`), `POST /api/workflows/reauth-cli/run` (`run_workflow`) |
| Audit (admin) | audit trail | — | `GET /api/audit` (`get_audit_log`) |
| Update badge (admin) | update availability | apply update | `GET /api/update-status` (`get_update_status`), `POST /api/update/apply` (`apply_update`) |
| Onboarding | runner online poll | mint runner token, create sample workflow | `POST /api/tokens` (`create_token`), `GET /api/runners` (`list_runners`), `POST /api/workflows` (`create_workflow`) |
| Assistant (floating chat) | provider status, chat replies | send message; model-proposed actions run client-side after user click | `GET /api/chat/status` (`get_assistant_status`), `POST /api/chat` (`ask_assistant`) |
| Brand page (admin) | CSS custom properties via `getComputedStyle` — a style guide, no API data | — | none (client-only by design) |

Client-computed presentation (badge counts, per-status filter counts,
success-rate chips, heartbeat freshness tones, promotion-button visibility)
derives exclusively from API responses listed above — any client can compute
the same values from the same endpoints.

## Intentional exemptions (no MCP tool, by design)

Recorded as `mcpExempt` in `src/apiSurface.js`; the test fails if one is
removed without either adding a tool or a reason.

- **Session bootstrap**: `/api/setup`, `/api/auth/token-login`,
  `/api/auth/telegram-webapp`, `/api/auth/logout` — browser cookie flows;
  MCP authenticates every call with the bearer token directly.
- **Runner protocol** (machine-to-machine, `runner` scope + run ownership):
  `/api/runners/register|heartbeat|next-run`, `POST /api/runs/:id/{events,start,complete,fail}`,
  `POST /api/runs/:id/artifacts`.
- **Streams/duplicates**: `GET /api/runs/:id/events/stream` (SSE; poll
  `get_run_events`/`get_run_timeline`), `GET /api/runs/:id/log-summary`
  (embedded in `get_run_diagnostics`).
- **Legacy aliases**: the `/api/capabilities/*` family and
  `/api/workflow-packages/capabilities/:id/export` (marked `deprecated` in
  OpenAPI; the MCP dispatcher still accepts old `*_capability` tool names).
- **Liveness/install/browser assets**: `/healthz`, `/readyz`, `/version`,
  `/api/version`, `/cli.tgz`, `/install.sh`, `/`, `/app`, `/docs*`,
  `/public`, `/llms.txt`, `/openapi.json`.
- **External callbacks**: `POST /api/telegram/webhook`.

## Notes and residual risks

- **Assistant client-side actions**: support-chat replies can carry a generic
  `api` action the browser executes after an explicit user click
  (`web/components/SupportChat.jsx`, guarded to `/api/*` paths). This is not
  a privileged path — it uses the same session and the server re-enforces
  scopes — but it is an LLM-driven call site and worth keeping guarded. The
  registry scan covers the guard's `/api/` prefix.
- **Runners page UI gating**: the web app shows Runners under Admin, but
  `GET /api/runners` is any-authenticated. The UI having *less* reach than
  the API is compatible with the invariant; documented here as deliberate.
- **CLI parity** is narrower than MCP by design (schedules/secrets/tokens are
  admin surfaces); this audit's scope is UI ↔ API ↔ MCP. See
  `specs/product-surface-audit.md` §8 for the CLI follow-ups.
- **Local UI state** (rerun drafts in sessionStorage, chat history in
  localStorage, panel open/closed state) is presentation state, not data —
  intentionally out of API scope.
