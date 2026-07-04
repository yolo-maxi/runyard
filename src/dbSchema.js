export const DB_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    skill_slugs TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_resources (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'doc',
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'General',
    keywords TEXT NOT NULL DEFAULT '[]',
    input_schema TEXT NOT NULL DEFAULT '{}',
    output_schema TEXT NOT NULL DEFAULT '{}',
    required_runner_tags TEXT NOT NULL DEFAULT '[]',
    required_skills TEXT NOT NULL DEFAULT '[]',
    required_agents TEXT NOT NULL DEFAULT '[]',
    approval_policy TEXT NOT NULL DEFAULT '{}',
    supervision TEXT NOT NULL DEFAULT '{}',
    workflow TEXT NOT NULL DEFAULT '{}',
    max_run_minutes INTEGER,
    definition_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capability_versions (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'offline',
    current_run_id TEXT,
    token_id TEXT,
    capacity INTEGER NOT NULL DEFAULT 1,
    active_runs INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_heartbeat_at TEXT
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    capability_slug TEXT NOT NULL,
    capability_name TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    runner_id TEXT,
    status TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  -- Self-heal lineage: one row per hub-supervisor decision (resume / repair /
  -- escalate / give_up) on a run. Lets the dashboard show *why* a run was
  -- re-dispatched and guarantees we can audit (and never silently loop) the
  -- reconcile loop's actions. Append-only.
  CREATE TABLE IF NOT EXISTS run_lineage (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    prev_runner_id TEXT,
    checkpoint TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'file',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  -- timeout_at/fallback/timer_state/timer_elapsed_at: timed-approval support.
  -- NULL timeout_at = blocking approval (waits for a human forever). When the
  -- timer elapses the hub applies the explicitly configured fallback decision,
  -- or — with no fallback — marks the still-pending card fallback_required.
  -- An elapsed timer is never a terminal failure for the linked run.
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT 'workflow',
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    decision TEXT,
    comment TEXT,
    timeout_at TEXT,
    fallback TEXT,
    timer_state TEXT NOT NULL DEFAULT '',
    timer_elapsed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_endpoints (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    secret_hash TEXT NOT NULL,
    capability_slug TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL DEFAULT '',
    repo_dir TEXT NOT NULL DEFAULT '',
    max_payload_bytes INTEGER NOT NULL DEFAULT 32768,
    rate_limit_count INTEGER NOT NULL DEFAULT 30,
    rate_limit_window_ms INTEGER NOT NULL DEFAULT 60000,
    dedupe_window_ms INTEGER NOT NULL DEFAULT 600000,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- DB-backed workflow bundles (publishing MVP). Append-only: each publish
  -- inserts a new (capability_slug, version) row; bytes are never edited in
  -- place, so a bundle id permanently names the exact published source. The
  -- 500 KB publish cap (MAX_WORKFLOW_BUNDLE_BYTES) is enforced before insert.
  CREATE TABLE IF NOT EXISTS workflow_bundles (
    id TEXT PRIMARY KEY,
    capability_slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    language TEXT NOT NULL DEFAULT 'tsx',
    code TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (capability_slug, version)
  );

  CREATE TABLE IF NOT EXISTS run_response_endpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    delivered_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_endpoint_invocations (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES workflow_endpoints(id) ON DELETE CASCADE,
    endpoint_slug TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    source_app TEXT NOT NULL DEFAULT '',
    source_user TEXT NOT NULL DEFAULT '',
    source_session TEXT NOT NULL DEFAULT '',
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    capability_slug TEXT NOT NULL,
    cron TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    input TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    run_at TEXT,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_id TEXT,
    last_status TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Admin-authored post-run hook profiles: optional side effects (static
  -- publish, git push, webhook, ...) invoked explicitly after a run's gates
  -- pass. Definitions are bounded JSON; secrets are referenced by NAME only
  -- (see secrets table) and never stored here. Additive: older code never
  -- reads this table, so rollbacks boot cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS hook_profiles (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    params TEXT NOT NULL DEFAULT '[]',
    secret_names TEXT NOT NULL DEFAULT '[]',
    allowed_capabilities TEXT NOT NULL DEFAULT '[]',
    definition_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    value_encrypted BLOB NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );

  -- Operator-facing alerts surfaced in the Hub UI (e.g. self-update outcomes:
  -- "update succeeded -> vX", "update failed, rolled back to vY"). Additive and
  -- self-contained: older code that predates this table simply never reads it,
  -- so a rollback to an earlier release boots cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS _smithers_alerts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_kind_created ON _smithers_alerts(kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_payload ON workflow_endpoint_invocations(endpoint_id, payload_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_endpoint ON workflow_endpoint_invocations(endpoint_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_run ON run_response_endpoints(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_status ON run_response_endpoints(delivery_status);
  CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_run_lineage_run ON run_lineage(run_id, created_at);
  -- The hub-supervisor failed-recoverable scan filters on status + recency; an
  -- index keeps the reconcile tick cheap as the runs table grows.
  CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
`;
