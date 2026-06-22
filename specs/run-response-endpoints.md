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

## Slice 1 scope (this doc)

- Contract for the optional `responseEndpoint` field on the run-creation API.
- Validation rules for endpoint type and shape.
- Persistence: normalized `run_response_endpoints` table with delivery
  bookkeeping (status, attempts, last attempt, delivered, last error).
- Safe surfacing: API responses, run events, and audit log entries include
  only a redacted summary of the endpoint, never the raw bearer tokens or
  header values the caller provided.

Slice 2 — out of scope for this doc — adds the actual outbound delivery
(retry policy, payload shape, signing) over `http` and `telegram`.

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

## Delivery (slice 2 contract — not implemented here)

When delivery lands it will:

- Fire once when the run reaches a terminal state: `succeeded`, `failed`, or
  `cancelled`.
- Send a structured payload containing:
  - `runId`, `status`, `currentStep`
  - `capabilitySlug`, `capabilityName`, `workflowVersion`
  - safe summary / output metadata (size, top-level keys; not a full input
    echo and not secret-shaped values)
  - artifact pointers (id, name, mimeType, sizeBytes, deepLink, download URL)
  - log/event pointers (`/api/runs/:id/events`, `/api/runs/:id/logs`)
  - Hub deep links (`/app#runs/:id`)
- Record each attempt in `run_response_endpoints` (`delivery_attempts`,
  `last_attempt_at`, `last_error`) and stamp `delivered_at` on success.
- Forward the caller-supplied `config.headers` blind on the outbound request
  (that is what they are for). Those values are **not** transcribed back into
  any Hub record visible via the API, events, or audit log.

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

`delivery_status` values used by slice 1: `pending`. Slice 2 will introduce
`in_flight`, `delivered`, `failed`, `abandoned`.

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
