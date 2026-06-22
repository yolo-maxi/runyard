# Run Response Endpoints

## Primitive

Runyard's primary run API is intake-only at `POST /api/capabilities/:id/run`.
Callers always get back a `runId` and can poll `GET /api/runs/:id` (and its
`/logs`, `/events`, `/artifacts` sub-resources) to fetch results. **That polling
path is the canonical, fallback, always-available contract.**

Many trusted callers (mobile apps, chat agents, downstream services) would
prefer Runyard *push* the result somewhere when the run finishes. This spec
introduces an optional per-run *response endpoint* — a small piece of caller-
supplied config attached to the run when it is created, telling the Hub where
to deliver the final reply once the run reaches a terminal state.

## Slice 1 scope

- Contract for the optional `responseEndpoint` field on the run-creation API.
- Validation rules for endpoint type and shape.
- Persistence: normalized `run_response_endpoints` table with delivery
  bookkeeping (status, attempts, last attempt, delivered, last error).
- Safe surfacing: API responses, run events, and audit log entries include
  only a redacted summary of the endpoint, never the raw bearer tokens or
  header values the caller provided.

## Slice 2 scope (this doc, current)

- Actual outbound delivery when a run reaches a terminal state.
- `http` provider: `POST`/`PUT` JSON payload to the configured URL, with the
  configured headers forwarded blind, a 10 s default timeout, and non-2xx
  treated as a failure (no retry policy — attempts are recorded so a future
  slice can add one).
- `telegram` provider: short terminal-state message sent via
  `api.telegram.org/bot<token>/sendMessage` with the configured `chatId`,
  optional `threadId` (mapped to `message_thread_id`), and optional
  `parseMode`. The Hub bot token is reused from `TELEGRAM_BOT_TOKEN` (or
  `SMITHERS_TELEGRAM_BOT_TOKEN`); when neither is set, delivery is recorded
  as failed (`last_error` explains why) — the run itself is not affected.
- Delivery is triggered from the same server-side terminal hooks the
  retrospective artifact uses (`/api/runs/:id/{complete,fail,cancel}`, the
  stale-run reaper, and approval-driven cancellation in `/api/approvals/:id/*`
  and the Telegram approval webhook), so any path that lands a run in a
  terminal state also notifies its registered endpoints.
- Idempotency: only `pending` endpoints are picked up; an endpoint that is
  already `delivered` / `in_flight` / `failed` / `abandoned` is skipped, so
  repeated terminal updates never fan out a second delivery. The row is
  flipped to `in_flight` *before* the outbound call so a concurrent attempt
  is a no-op too.

Future work (out of scope for this slice):

- Retry policy / exponential backoff for `failed` rows.
- `email` provider and any signed-payload variant.

## Contract at run-creation time

`POST /api/capabilities/:id/run` accepts an optional `responseEndpoint` on the
request body, alongside the existing `input` / `chain` / `runnerId` fields:

```jsonc
{
  "input": { "topic": "..." },
  "responseEndpoint": {
    "type": "http",
    "config": {
      "url": "https://app.example.com/webhooks/runyard",
      "method": "POST",
      "headers": { "x-app-tenant": "tenant-42" }
    }
  }
}
```

- The field is **optional**. Run creation works exactly as before when the
  field is omitted; polling by `runId` remains the only result path.
- The endpoint is attached to the run created by the request and lives in its
  own normalized DB row. It is **never** copied into the run's `input` payload
  (where it would flow into workflow context, logs, and audit detail).
- The Hub treats every endpoint as **untrusted caller-supplied configuration**.
  It is validated server-side at registration time. A malformed endpoint shape
  fails with `400` and the run is **not** created.
- The returned run response includes a redacted `responseEndpoint` summary so
  the caller can confirm what was registered. `GET /api/runs/:id` also exposes
  a `responseEndpoints` array with the same redacted shape and the current
  delivery bookkeeping.

## Supported endpoint types (slice 1)

### `http`

- `config.url` (required) — must parse as a URL and use `http:` or `https:`.
- `config.method` (optional) — `POST` or `PUT`. Defaults to `POST`.
- `config.headers` (optional) — object of extra headers to send on delivery.
  Header names must match `^[A-Za-z0-9-]{1,64}$`; values must be strings up to
  1 KiB. Sensitive headers (e.g. `authorization`, `cookie`, `x-api-key`) are
  accepted for delivery but their values are **never** echoed back in API
  responses, events, or audit entries.

### `telegram`

- `config.chatId` (required) — destination chat id, string or number.
- `config.threadId` (optional) — topic/thread id, number.
- `config.parseMode` (optional) — `MarkdownV2`, `Markdown`, or `HTML`.

`email` is intentionally out of scope for this slice. Adding it later follows
the same model: new `type`, new `config` validator, no change to the contract.

## Delivery payload (slice 2)

Delivery fires once when the run reaches a terminal state: `succeeded`,
`failed`, or `cancelled`. The Hub builds a single sanitized payload per run
and sends it to every endpoint attached to that run.

```jsonc
{
  "schemaVersion": "runyard.run.response.v1",
  "runId": "run_…",
  "status": "succeeded" | "failed" | "cancelled",
  "currentStep": "…",
  "capability": {
    "id": "cap_…",
    "slug": "…",
    "name": "…",
    "workflowVersion": 7
  },
  "timestamps": {
    "createdAt": "…",
    "startedAt": "…",
    "completedAt": "…",
    "durationMs": 12345
  },
  "error": "…concise message when status === failed…",
  "output": {
    "kind": "object",
    "keyCount": 3,
    "keys": ["ok", "report", "links"],
    "sizeBytes": 412
  },
  "artifacts": [
    { "id": "art_…", "name": "…", "mimeType": "…",
      "sizeBytes": 0, "deepLink": "/app#runs/run_…/artifacts/art_…",
      "downloadUrl": "<base>/api/artifacts/art_…/download" }
  ],
  "links": {
    "run": "/app#runs/run_…",
    "runDetail": "<base>/api/runs/run_…",
    "logs": "<base>/api/runs/run_…/logs",
    "events": "<base>/api/runs/run_…/events",
    "artifacts": "<base>/api/runs/run_…/artifacts"
  },
  "deliveredAt": "…"
}
```

The Hub also:

- Records each attempt in `run_response_endpoints` (`delivery_status`,
  `delivery_attempts`, `last_attempt_at`, `last_error`) and stamps
  `delivered_at` on success.
- Forwards the caller-supplied `config.headers` blind on the outbound `http`
  request (that is what they are for). Those values are **not** transcribed
  back into any Hub record visible via the API, events, or audit log — the
  redacted `summary` shape is the only thing surfaced.
- For `telegram` delivery: the configured `chatId`, `threadId`
  (`message_thread_id`), and optional `parseMode` are sent to
  `api.telegram.org/bot<token>/sendMessage`. The bot token is sourced from
  `TELEGRAM_BOT_TOKEN` or `SMITHERS_TELEGRAM_BOT_TOKEN`; missing token
  becomes a recorded delivery failure (the run is unaffected). No bot token
  is hardcoded.

The output summary deliberately reports only key *names* (no values),
top-level type, and a byte size — so a workflow that returns
`{ ok: true, secret: "…" }` cannot leak `"…"` through delivery.

## Audit / log safety

- The raw endpoint config (URLs with query secrets, custom headers, bearer
  tokens, telegram chatIds) is stored only in `run_response_endpoints.config`
  and used solely for outbound delivery.
- The `run.response_endpoint.registered` event and the matching
  `run.response_endpoint.registered` audit entry reference the endpoint by id,
  type, and a redacted summary:
  - `http` → host + path + redacted query string, method, list of header
    *names* (no values).
  - `telegram` → chatId, optional thread id, optional parse mode.
- API responses return the same redacted summary. Raw config is never echoed
  back, even to the original caller.

## DB shape

```sql
CREATE TABLE run_response_endpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                          -- 'http' | 'telegram'
  config TEXT NOT NULL DEFAULT '{}',           -- JSON, server-validated
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_run_response_endpoints_run ON run_response_endpoints(run_id);
CREATE INDEX idx_run_response_endpoints_status ON run_response_endpoints(delivery_status);
```

`delivery_status` values:

- `pending` — registered, not yet attempted (slice 1 default).
- `in_flight` — claimed by the delivery loop; another concurrent attempt
  skips the row.
- `delivered` — outbound call returned 2xx; `delivered_at` is stamped and
  the row is never picked up again.
- `failed` — outbound call returned non-2xx, timed out, or a provider
  precondition is missing (e.g. telegram bot token unset). `last_error`
  holds a redacted, length-bounded message. Slice 2 records but does not
  retry; a future slice may add backoff.
- `abandoned` — reserved for future use (e.g. retry budget exhausted).

## Helper functions (db layer)

- `createRunResponseEndpoint({ runId, type, config, createdBy })` — insert a
  validated row, return the normalized record.
- `listRunResponseEndpointsForRun(runId)` — return all endpoints attached to a
  run, normalized with a redacted `summary` field.
- `listPendingRunResponseEndpoints(limit)` — for slice 2's delivery loop.
- `updateRunResponseEndpointDelivery(id, { status, attempts, lastAttemptAt,
  deliveredAt, lastError })` — slice 2's bookkeeping update path.

These helpers are exercised through `parseResponseEndpoint` in
`src/runResponseEndpoint.js`, which is the single validator the HTTP route
uses before any DB write.
