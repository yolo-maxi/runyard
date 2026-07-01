-- Postgres mirror schema for the RunYard Electric demo.
-- SQLite remains the system of record; the projector (src/electric/projector.js)
-- mirrors these tables so ElectricSQL can sync them to clients as shape logs.
-- Timestamps are kept as text (verbatim ISO-8601 from SQLite, lossless). JSON
-- columns are jsonb. Electric requires a primary key on every synced table.

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  capability_id text,
  capability_slug text,
  capability_name text,
  workflow_version text,
  runner_id text,
  status text,
  current_step text,
  input jsonb,
  output jsonb,
  error text,
  created_at text,
  assigned_at text,
  started_at text,
  completed_at text,
  updated_at text,
  parent_run_id text,
  attempt integer,
  repair_count integer
);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);

CREATE TABLE IF NOT EXISTS run_events (
  -- seq is the SQLite rowid: a stable, monotonic per-insert cursor and the
  -- natural ordering key for the live trace stream.
  seq bigint PRIMARY KEY,
  id text NOT NULL,
  run_id text NOT NULL,
  type text NOT NULL,
  message text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS runners (
  id text PRIMARY KEY,
  name text,
  hostname text,
  platform text,
  version text,
  tags jsonb,
  status text,
  current_run_id text,
  capacity integer,
  active_runs integer,
  auth_health jsonb,
  created_at text,
  last_heartbeat_at text
);

CREATE TABLE IF NOT EXISTS capabilities (
  id text PRIMARY KEY,
  slug text,
  name text,
  description text,
  category text,
  keywords jsonb,
  version integer,
  enabled integer,
  created_at text,
  updated_at text
);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text,
  status text,
  title text,
  description text,
  requested_by text,
  payload jsonb,
  created_at text,
  resolved_at text,
  resolved_by text,
  decision text,
  comment text
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text,
  name text,
  kind text,
  mime_type text,
  size_bytes bigint,
  path text,
  metadata jsonb,
  created_at text
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id);
