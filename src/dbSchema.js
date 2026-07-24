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
    usage TEXT,
    budget TEXT,
    pause TEXT,
    work_item_id TEXT,
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
    -- Monotonic per-run cursor (0-based), mirroring the Smithers engine's
    -- per-run event seq. Assigned atomically at insert; the SSE stream and
    -- CLI --follow replay/resume from it. NULL only on pre-migration rows
    -- until migrateRunEventsSeqColumn backfills them (src/db.js).
    seq INTEGER,
    created_at TEXT NOT NULL
  );

  -- Historical lineage table retained for existing databases. No active
  -- runtime path writes supervisor decisions after supervisor removal.
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
  --
  -- kind/resolution/resolved_via: the honest approval lifecycle. status is
  -- only pending|resolved; what was decided lives in resolution
  -- (approved|rejected|changes_requested|superseded|option:*) and who/what
  -- decided lives in resolved_via (human|fallback_timer|engine|policy|
  -- system). decision is retained as the legacy field and mirrors resolution
  -- for human-vocabulary decisions. The CHECKs bind fresh installs only;
  -- existing installs are backfilled by
  -- migrateApprovalsKindResolutionColumns (ALTER cannot add constraints).
  --
  -- ask: the declared question (JSON: audience/action/reason/options),
  -- supplied by the creator and rendered verbatim by every surface. NULL =
  -- the card predates the ask contract (or its creator did not declare one);
  -- presentation falls back to a heuristic ask explicitly marked derived.
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('workflow_gate', 'escalation', 'side_effect', 'custom')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT 'workflow',
    ask TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution TEXT CHECK (
      resolution IS NULL
      OR resolution IN ('approved', 'rejected', 'changes_requested', 'superseded')
      OR resolution LIKE 'option:%'
    ),
    resolved_via TEXT CHECK (
      resolved_via IS NULL OR resolved_via IN ('human', 'fallback_timer', 'engine', 'policy', 'system')
    ),
    decision TEXT,
    comment TEXT,
    timeout_at TEXT,
    fallback TEXT,
    timer_state TEXT NOT NULL DEFAULT '',
    timer_elapsed_at TEXT,
    telegram_message TEXT
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
    disabled_reason TEXT NOT NULL DEFAULT '',
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

  -- Run-creation negotiation drafts: proposed runs that have NOT been
  -- enqueued. status mirrors the latest deterministic preflight (ready /
  -- needs_input / blocked) until the draft is submitted (run_id records the
  -- run it became) or discarded. Additive: older code never reads this table,
  -- so rollbacks boot cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS run_drafts (
    id TEXT PRIMARY KEY,
    capability_slug TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    options TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'needs_input',
    preflight TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT '',
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Per-run model-call usage records — one row per observed inference call
  -- (metering gateway or runner-reported engine usage events). The run's
  -- rolled-up totals live in runs.usage; these rows are the auditable detail.
  -- Additive: older code never reads this table, so rollbacks boot cleanly.
  CREATE TABLE IF NOT EXISTS run_usage_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER,
    step_id TEXT,
    node_id TEXT,
    agent_label TEXT,
    source TEXT NOT NULL DEFAULT '',
    request_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  -- Durable company work items ("tickets"): the unit of work a human plans
  -- and tracks, distinct from workflows (reusable recipes) and runs (single
  -- execution attempts). Lifecycle status is the human-legible enum in
  -- src/workItemRecords.js (intake..archived); a failed run never fails a
  -- work item — it moves to waiting/blocked/review with an explicit reason.
  -- Runs attach via the nullable runs.work_item_id column (many runs per
  -- item; unlinked runs stay NULL). Additive: older code never reads this
  -- table, so rollbacks boot cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'feature',
    status TEXT NOT NULL DEFAULT 'intake',
    priority TEXT NOT NULL DEFAULT 'normal',
    owner TEXT NOT NULL DEFAULT '',
    requester TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    blocked_reason TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Ticket history mirroring run_events: status moves, run link/unlink, edits.
  CREATE TABLE IF NOT EXISTS work_item_events (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  -- Boards: durable configured views over work_items (the software-factory
  -- surfaces). Lane definitions and default workflow launch suggestions are
  -- JSON; project scopes the board's membership ('' = all work items). One
  -- row is seeded as the instance default on first boot (boardStore).
  -- Additive: older code never reads this table, so rollbacks boot cleanly.
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    lanes TEXT NOT NULL DEFAULT '[]',
    default_workflows TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
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

  -- SCM (GitHub App) installation identity for the CI platform. Identity and
  -- sync bookkeeping only — installation access tokens are minted just in
  -- time and NEVER persisted anywhere. Additive: older code never reads this
  -- table, so rollbacks boot cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS scm_installations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'github',
    installation_id TEXT NOT NULL,
    account_login TEXT NOT NULL DEFAULT '',
    account_type TEXT NOT NULL DEFAULT '',
    app_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, installation_id)
  );

  -- CI-connected repositories. GitHub stays the canonical repo host; this row
  -- is RunYard's provider-neutral identity + policy record. enabled defaults
  -- OFF: connecting an installation never silently starts running CI.
  -- trust_policy JSON: { level: 'trusted'|'untrusted', allowNative: bool,
  -- runnerTags: [..] } — see specs/ci-platform.md. Additive: older code never
  -- reads this table, so rollbacks boot cleanly against a migrated DB.
  CREATE TABLE IF NOT EXISTS scm_repos (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'github',
    external_id TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    clone_url TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT 'main',
    installation_id TEXT NOT NULL DEFAULT '',
    private INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    trust_policy TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, full_name)
  );

  -- Webhook receipt/idempotency ledger. One row per provider delivery id;
  -- payload_hash detects a replayed id carrying different bytes (conflict).
  -- detail is a bounded audit summary — never the full payload, never
  -- secrets. Rows are pruned by the CI sweep after the configured retention
  -- window (bounded by design). Additive: older code never reads this table.
  CREATE TABLE IF NOT EXISTS scm_webhook_deliveries (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'github',
    delivery_id TEXT NOT NULL,
    event TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL DEFAULT '',
    repo_full_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'accepted',
    detail TEXT NOT NULL DEFAULT '{}',
    pipeline_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (provider, delivery_id)
  );

  -- CI pipelines: one row per accepted trigger. The pipeline's LIVE status is
  -- the linked parent run (runs.id = run_id) — never duplicated here; this
  -- row owns the immutable provenance (trigger, config source SHA, tested
  -- checkout semantics, check target SHA) and the concurrency/supersede
  -- bookkeeping. Additive: older code never reads this table.
  CREATE TABLE IF NOT EXISTS ci_pipelines (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES scm_repos(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT 'ci',
    trigger TEXT NOT NULL DEFAULT '{}',
    config_source TEXT NOT NULL DEFAULT '{}',
    tested TEXT NOT NULL DEFAULT '{}',
    commit_sha TEXT NOT NULL DEFAULT '',
    concurrency_key TEXT NOT NULL DEFAULT '',
    superseded_by TEXT,
    check_run_id TEXT NOT NULL DEFAULT '',
    check_state TEXT NOT NULL DEFAULT '',
    check_attempts INTEGER NOT NULL DEFAULT 0,
    check_attempts_for TEXT NOT NULL DEFAULT '',
    last_check_error TEXT NOT NULL DEFAULT '',
    check_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- CI jobs: one row per configured job of a pipeline. phase covers only the
  -- pre/non-dispatch lifecycle (pending|dispatched|skipped|cancelled); once
  -- dispatched the linked canonical run's status is the single source of
  -- truth. check_* columns are the GitHub Checks reporter ledger (modeled on
  -- run_response_endpoints delivery bookkeeping). Additive: older code never
  -- reads this table.
  CREATE TABLE IF NOT EXISTS ci_jobs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL REFERENCES ci_pipelines(id) ON DELETE CASCADE,
    job_name TEXT NOT NULL,
    needs TEXT NOT NULL DEFAULT '[]',
    executor TEXT NOT NULL DEFAULT 'native',
    spec TEXT NOT NULL DEFAULT '{}',
    required INTEGER NOT NULL DEFAULT 1,
    phase TEXT NOT NULL DEFAULT 'pending',
    phase_reason TEXT NOT NULL DEFAULT '',
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    check_run_id TEXT NOT NULL DEFAULT '',
    check_state TEXT NOT NULL DEFAULT '',
    check_attempts INTEGER NOT NULL DEFAULT 0,
    check_attempts_for TEXT NOT NULL DEFAULT '',
    last_check_error TEXT NOT NULL DEFAULT '',
    check_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (pipeline_id, job_name)
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_kind_created ON _smithers_alerts(kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_run_usage_run ON run_usage_records(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_payload ON workflow_endpoint_invocations(endpoint_id, payload_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_endpoint ON workflow_endpoint_invocations(endpoint_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_run ON run_response_endpoints(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_status ON run_response_endpoints(delivery_status);
  CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_run_drafts_status ON run_drafts(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_run_lineage_run ON run_lineage(run_id, created_at);
  -- Status/recency lookups are common in maintenance and run-history paths.
  CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_work_item_events_item ON work_item_events(work_item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_scm_repos_enabled ON scm_repos(enabled, updated_at);
  CREATE INDEX IF NOT EXISTS idx_scm_webhook_deliveries_created ON scm_webhook_deliveries(created_at);
  CREATE INDEX IF NOT EXISTS idx_scm_webhook_deliveries_status ON scm_webhook_deliveries(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_ci_pipelines_repo ON ci_pipelines(repo_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ci_pipelines_run ON ci_pipelines(run_id);
  CREATE INDEX IF NOT EXISTS idx_ci_pipelines_concurrency ON ci_pipelines(concurrency_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_ci_jobs_pipeline ON ci_jobs(pipeline_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ci_jobs_run ON ci_jobs(run_id);
  CREATE INDEX IF NOT EXISTS idx_ci_jobs_check ON ci_jobs(check_state, updated_at);
`;

// The runs(work_item_id) index lives in src/db.js (migrateRunsWorkItemColumn)
// because on pre-existing databases the column is added by ALTER TABLE after
// this schema string runs — a CREATE INDEX here would reference a column that
// does not exist yet.
