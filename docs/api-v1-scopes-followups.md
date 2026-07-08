# Follow-ups: grouped API taxonomy and scoped tokens

Status notes for the work shipped with the API normalization + scoped-tokens
release (grouped registry metadata, `/api/v1` aliases, `read` scope, scope
presets, Tokens page groups). Each item below was deliberately deferred; the
shipped state is safe without them.

## 1. Fine-grained per-group write scopes

Today the mutation scopes are coarse: `api`/`mcp` grant the entire operating
surface (run + drafts + cancel/rerun/promote + approval decisions), because
`requireScopes(...)` passes on ANY listed scope. Presets like
"workflow operator" / "automation manager" / "library manager" would
overpromise — an `api`-scoped token can always decide approvals — so they were
NOT shipped.

To ship them honestly:
- pass the registry operation (its `group` + read/write class) into the scope
  middleware (serverRoutes already interprets per-operation, so
  `requireScopes` can close over the operation), and
- accept group-scoped tokens like `workflows:write`, `automation:write`
  validated against `API_GROUPS`,
- while guaranteeing group scopes NEVER satisfy `admin`-gated or
  `runner`-gated operations (runner protocol safety), and keeping `admin` as
  the superscope and existing coarse scopes untouched.
The `groups` field on `TOKEN_SCOPE_METADATA` entries already names each
scope's write groups so the UI/API shape won't change.

## 2. `/api/v1/system/runners/*` aliases

The runner routes are registered externally (`src/routes/runners.js`), so the
alias generator skips them (`external` entries cannot declare `v1Path` —
test-enforced). If v1 aliases are wanted for `GET /api/runners` (the only
human-facing one), either move runner routes into the registry interpreter or
teach `registerRunnerRoutes` to register alias paths. The runner *machine*
protocol (register/heartbeat/next-run/lifecycle) should stay unversioned
regardless — runners pin their Hub protocol.

## 3. Assistant endpoints and the `read` scope

`POST /api/chat` is any-authenticated (it never mutates server-side — actions
come back as confirmation buttons). A read-only token can therefore use the
assistant, which spends LLM budget. If that's unwanted, gate `/api/chat` with
`scopes: ["api", "mcp"]` — but note Telegram approvals sessions
(`approvals`-scoped) would then also lose it. Decide deliberately; the current
state is honest (chat cannot change app state).

## 4. Deprecation timeline for `/api/capabilities/*`

The legacy aliases are marked `deprecated` in OpenAPI, get no `/api/v1` form,
and the wording-guard test (tests/capability-copy.test.js) keeps capability
language out of user-facing copy. Removal is a future major-version decision;
until then the MCP dispatcher also keeps accepting `*_capability` tool names.

## 5. UI odds and ends

- Onboarding's runner-token mint stays hard-coded to `["runner"]` on purpose
  (simple + safe). The Connect invite and Tokens page share the ScopePicker.
- MCP `create_token` defaults to `["api","mcp"]` (mirrors the HTTP default),
  not the "everything" preset; aligning them is a product call.
