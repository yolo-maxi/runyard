import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";
import { id, now } from "./ids.js";
import { emitRunEvent } from "./runEventBus.js";
import { hashToken, randomToken } from "./security.js";
import { SUPERVISOR_CAPABILITY_SLUG } from "./supervision.js";
import { decrypt as decryptSecret, encrypt as encryptSecret, redactSecrets, secretsEnabled } from "./secretsStore.js";
import {
  canTransitionRun,
  RUN_TERMINAL
} from "./runLifecyclePolicy.js";
import { normalizeCapability } from "./capabilityRecords.js";
import { createCapabilityStore } from "./capabilityStore.js";
import { createWorkflowEndpointStore } from "./workflowEndpointStore.js";
import { createWorkflowBundleStore } from "./workflowBundleStore.js";
import { createRunResponseEndpointStore } from "./runResponseEndpointStore.js";
import { createAccessTokenStore } from "./accessTokenStore.js";
import { createCatalogStore } from "./catalogStore.js";
import { createDbBootstrap } from "./dbBootstrap.js";
import { DB_SCHEMA_SQL } from "./dbSchema.js";
import {
  missingColumnAlterQueries,
  tableColumnsQuery
} from "./schemaMigrationRecords.js";
import { createSecretStore } from "./secretStore.js";
import { normalizeRun } from "./runRecords.js";
import {
  runnerPoolStatusQueries,
  runnerPoolSummary
} from "./runnerPoolRecords.js";
import { createOperatorStore } from "./operatorStore.js";
import { createRunSupervisorStore } from "./runSupervisorStore.js";
import {
  buildRuntimePack
} from "./runtimePackRecords.js";
import { supportRunnerAvailabilityResult } from "./runnerAssignment.js";
import {
  applyDashboardPoolStats,
  dashboardCountQuery,
  DASHBOARD_COUNT_TABLES,
  pendingApprovalsCountQuery,
  runningRunsCountQuery
} from "./dashboardStats.js";
import { createScheduleStore } from "./scheduleStore.js";
import { createRunStore } from "./runStore.js";
import { createRunnerStore } from "./runnerStore.js";
import { createRunCreateStore } from "./runCreateStore.js";
import { createRunMutationStore } from "./runMutationStore.js";
import { createRunClaimStore } from "./runClaimStore.js";

export { normalizeSchedule } from "./scheduleRecords.js";

export const db = new DatabaseSync(env.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const INTERNAL_SUPPORT_RUN_WHERE = "COALESCE(json_extract(input, '$.__origin.type'), '') = 'support-chat'";
const SUPPORT_AGENT_CAPABILITY_SLUG = "runyard-support-agent";
const REAUTH_CAPABILITY_SLUG = "reauth-cli";
export const DEFAULT_HIDDEN_RUN_SLUGS = [SUPPORT_AGENT_CAPABILITY_SLUG, REAUTH_CAPABILITY_SLUG];
const DEFAULT_HIDDEN_RUN_WHERE = [
  INTERNAL_SUPPORT_RUN_WHERE,
  `capability_slug IN (${DEFAULT_HIDDEN_RUN_SLUGS.map((slug) => `'${slug}'`).join(", ")})`
].join(" OR ");
const VISIBLE_RUN_WHERE = `NOT (${DEFAULT_HIDDEN_RUN_WHERE})`;

export function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function one(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params);
}

function all(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params);
}

function run(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params);
}

const catalogStore = createCatalogStore({ all, one, run, id, now });
const capabilityStore = createCapabilityStore({ all, one, run, id, now });
const runStore = createRunStore({ all, one, run, id, now, visibleRunWhere: VISIBLE_RUN_WHERE });
const runMutationStore = createRunMutationStore({ one, run, now, getRun, adjustRunnerActiveRuns });
const runClaimStore = createRunClaimStore({
  run,
  now,
  getRunner,
  supervisorPoolSize,
  runnerLoad,
  listRuns,
  getCapability,
  adjustRunnerActiveRuns,
  addRunEvent,
  getRun,
  getDecryptedSecretEnv,
  buildAgentRuntimePack,
  getWorkflowBundle,
  supervisorCapabilitySlug: SUPERVISOR_CAPABILITY_SLUG
});
const runCreateStore = createRunCreateStore({
  run,
  id,
  now,
  scrubStoredSecrets,
  addRunEvent,
  createApproval,
  getRun
});
const runnerStore = createRunnerStore({
  all,
  one,
  run,
  id,
  now,
  runnerOfflineMs: env.runnerOfflineMs,
  runnerPruneMs: env.runnerPruneMs,
  supervisorCapabilitySlug: SUPERVISOR_CAPABILITY_SLUG,
  supervisorSlotRatio: env.supervisorSlotRatio
});
const operatorStore = createOperatorStore({ all, one, run, id, now, addRunEvent, getRun, updateRun });
const scheduleStore = createScheduleStore({ all, one, run, id, now });
const workflowEndpointStore = createWorkflowEndpointStore({ all, one, run, id, now, hashToken });
const workflowBundleStore = createWorkflowBundleStore({ all, one, run, id, now });
const secretStore = createSecretStore({
  all,
  one,
  run,
  now,
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  redactSecrets,
  secretsEnabled
});
const runResponseEndpointStore = createRunResponseEndpointStore({ all, one, run, id, now });
const accessTokenStore = createAccessTokenStore({ all, one, run, id, now, randomToken });
const runSupervisorStore = createRunSupervisorStore({
  all,
  one,
  run,
  id,
  now,
  env,
  transitionRun,
  addRunEvent,
  adjustRunnerActiveRuns,
  createApproval
});
const dbBootstrap = createDbBootstrap({
  one,
  run,
  now,
  env,
  randomToken,
  createAccessToken,
  upsertSkill,
  upsertAgent,
  upsertKnowledge,
  upsertCapability,
  upsertWorkflowEndpoint
});

export function initDb() {
  db.exec(DB_SCHEMA_SQL);

  migrateRunnersPoolColumns();
  migrateCapabilitySupervisionColumn();
  migrateCapabilityDeadlineColumn();
  migrateCapabilityDefinitionHashColumn();
  migrateRunsCapabilityVersioningColumns();
  migrateRunnerAuthHealthColumn();
  migrateRunsSupervisorColumns();
  migrateApprovalsTimerColumns();
  dbBootstrap.setSettingDefault("instance_name", env.instanceName);
  dbBootstrap.seedCatalog();
  dbBootstrap.seedWorkflowEndpoints();
  autoQueueLegacyRunStartApprovals();
  dbBootstrap.ensureBootstrapToken();
}

// Capacity / active_runs were added after the initial schema shipped. Existing
// installs may already have a runners table without these columns — the CREATE
// TABLE IF NOT EXISTS above is a no-op there, so we add the columns manually.
function migrateMissingColumns(table, columns) {
  const query = tableColumnsQuery(table);
  const existingColumns = all(query.sql, query.params).map((row) => row.name);
  for (const alter of missingColumnAlterQueries({ table, existingColumns, columns })) {
    db.exec(alter.sql);
  }
}

function migrateRunnersPoolColumns() {
  migrateMissingColumns("runners", [
    { name: "capacity", definition: "capacity INTEGER NOT NULL DEFAULT 1" },
    { name: "active_runs", definition: "active_runs INTEGER NOT NULL DEFAULT 0" }
  ]);
}

// `supervision` (the default-supervision-envelope flag) shipped after the
// initial capabilities schema. Add the column on existing installs so seeding
// can populate it; the CREATE TABLE above is a no-op when the table exists.
function migrateCapabilitySupervisionColumn() {
  migrateMissingColumns("capabilities", [
    { name: "supervision", definition: "supervision TEXT NOT NULL DEFAULT '{}'" }
  ]);
}

// Per-capability execution deadline (minutes). NULL means "use the global
// SMITHERS_RUN_DEADLINE_MS default" — long-running workflows (e.g. audits)
// declare a larger value so the stuck-run reaper doesn't kill them at 30m.
function migrateCapabilityDeadlineColumn() {
  migrateMissingColumns("capabilities", [
    { name: "max_run_minutes", definition: "max_run_minutes INTEGER" }
  ]);
}

function migrateCapabilityDefinitionHashColumn() {
  migrateMissingColumns("capabilities", [
    { name: "definition_hash", definition: "definition_hash TEXT NOT NULL DEFAULT ''" }
  ]);
}

// Capability version pinning + rollback (behind RUNYARD_CAPABILITY_VERSIONING).
// Both columns are nullable — the flag-off path stores NULL and the existing
// run flow is unchanged. ALTER TABLE is idempotent via PRAGMA table_info.
function migrateRunsCapabilityVersioningColumns() {
  migrateMissingColumns("runs", [
    { name: "capability_sha", definition: "capability_sha TEXT" },
    { name: "parent_run_id", definition: "parent_run_id TEXT" }
  ]);
}

// Per-runner CLI auth health (Codex/Claude subscription auth) rides along on
// the heartbeat. Stored as a JSON blob; NULL until a runner reports it, so the
// CREATE TABLE no-op on existing installs is backfilled here. Never holds token
// material — only {ok, expiresAt?, accountId?} booleans/strings.
function migrateRunnerAuthHealthColumn() {
  migrateMissingColumns("runners", [
    { name: "auth_health", definition: "auth_health TEXT" }
  ]);
}

// Hub-as-supervisor accounting. These counters must survive a hub restart so
// the attempt/repair caps and the loop-breaker can't be reset by bouncing the
// process. `supervisor_meta` is a JSON blob holding the per-fingerprint resume
// and repair maps plus the loop-breaker progress marker; the scalar columns are
// the hot fields the reconcile query reads. All nullable/defaulted so the
// CREATE TABLE no-op on existing installs is backfilled here.
function migrateRunsSupervisorColumns() {
  migrateMissingColumns("runs", [
    { name: "attempt", definition: "attempt INTEGER NOT NULL DEFAULT 0" },
    { name: "repair_count", definition: "repair_count INTEGER NOT NULL DEFAULT 0" },
    { name: "supervisor_meta", definition: "supervisor_meta TEXT" }
  ]);
}

// Timed approvals. NULL timeout_at = blocking approval (waits forever, the
// PR #9 contract). `fallback` is the explicitly configured autopilot decision
// applied when the timer elapses; with none the card is marked
// timer_state='fallback_required' but stays pending, so the approval hold
// keeps protecting the run. All nullable/defaulted: existing rows are plain
// blocking approvals after this backfill.
function migrateApprovalsTimerColumns() {
  migrateMissingColumns("approvals", [
    { name: "timeout_at", definition: "timeout_at TEXT" },
    { name: "fallback", definition: "fallback TEXT" },
    { name: "timer_state", definition: "timer_state TEXT NOT NULL DEFAULT ''" },
    { name: "timer_elapsed_at", definition: "timer_elapsed_at TEXT" }
  ]);
}

export function createAccessToken(name, token = randomToken(), scopes = ["api"], options = {}) {
  return accessTokenStore.createAccessToken(name, token, scopes, options);
}

export function listAccessTokens() {
  return accessTokenStore.listAccessTokens();
}

export function getAccessToken(tokenId) {
  return accessTokenStore.getAccessToken(tokenId);
}

export function revokeAccessToken(tokenId) {
  return accessTokenStore.revokeAccessToken(tokenId);
}

export function authenticateToken(token) {
  return accessTokenStore.authenticateToken(token);
}

export { normalizeCapability };

export function listCapabilities({ q = "", includeDisabled = false } = {}) {
  return capabilityStore.listCapabilities({ q, includeDisabled });
}

export function getCapability(slugOrId) {
  return capabilityStore.getCapability(slugOrId);
}

export function upsertCapability(input) {
  return capabilityStore.upsertCapability(input);
}

// --- Encrypted reusable secrets ---------------------------------------------
// Values are AES-256-GCM encrypted at rest (see src/secretsStore.js). The only
// way a plaintext value leaves the DB is via getDecryptedSecretEnv() at run
// claim time (injected as env into the run's child process) — never through a
// list/read API. secretsEnabled() gates the whole feature; the server maps a
// disabled store to a 503.

export { secretsEnabled };

// List names + metadata only. NEVER returns or decrypts values.
export function listSecretMeta() {
  return secretStore.listSecretMeta();
}

export function secretExists(key) {
  return secretStore.secretExists(key);
}

// Upsert an encrypted secret. `value` is plaintext; it is encrypted here and
// the plaintext is never persisted or logged. Throws if the store is disabled.
export function upsertSecret({ key, value, description = "", createdBy = "" }) {
  return secretStore.upsertSecret({ key, value, description, createdBy });
}

export function getSecretMeta(key) {
  return secretStore.getSecretMeta(key);
}

export function deleteSecret(key) {
  return secretStore.deleteSecret(key);
}

// Decrypt the secrets named in `names` into a { NAME: value } env map. Used at
// run claim time to inject only the allowlisted secrets into one run. Unknown
// names are silently skipped. Returns {} when the store is disabled.
export function getDecryptedSecretEnv(names = []) {
  return secretStore.getDecryptedSecretEnv(names);
}

// Every stored plaintext secret value, used only to scrub run output/artifacts/
// logs before persistence. Returns [] when disabled. Never exposed via API.
export function allSecretValues() {
  return secretStore.allSecretValues();
}

// Scrub any stored secret value out of an arbitrary JSON-ish value (run output,
// artifact content, event data/message). Last line of defense before anything a
// runner posts is persisted or echoed back through the API. No-op when the
// store is disabled or empty.
export function scrubStoredSecrets(value) {
  return secretStore.scrubStoredSecrets(value);
}

// --- DB-backed workflow bundles ----------------------------------------------
// Published workflow source stored in the app DB (not runner disk, not external
// blob storage). Immutable per row: publish always creates the next version for
// a capability slug; capabilities reference a specific row via
// workflow.bundleId. The 500 KB cap is enforced inside the store before insert.

export function publishWorkflowBundle(input) {
  return workflowBundleStore.publishWorkflowBundle(input);
}

export function getWorkflowBundle(bundleId, options = {}) {
  return workflowBundleStore.getWorkflowBundle(bundleId, options);
}

export function listWorkflowBundles(options = {}) {
  return workflowBundleStore.listWorkflowBundles(options);
}

export function listWorkflowEndpoints({ includeDisabled = false } = {}) {
  return workflowEndpointStore.listWorkflowEndpoints({ includeDisabled });
}

export function getWorkflowEndpoint(slugOrId, { includeSecretHash = false, includeDisabled = false } = {}) {
  return workflowEndpointStore.getWorkflowEndpoint(slugOrId, { includeSecretHash, includeDisabled });
}

export function upsertWorkflowEndpoint(input, options = {}) {
  return workflowEndpointStore.upsertWorkflowEndpoint(input, options);
}

export function countWorkflowEndpointInvocations(endpointId, sinceIso) {
  return workflowEndpointStore.countWorkflowEndpointInvocations(endpointId, sinceIso);
}

export function findRecentWorkflowEndpointInvocation(endpointId, payloadHash, sinceIso) {
  return workflowEndpointStore.findRecentWorkflowEndpointInvocation(endpointId, payloadHash, sinceIso);
}

export function recordWorkflowEndpointInvocation({ endpoint, payloadHash, source = {}, runId = null, status = "queued" }) {
  return workflowEndpointStore.recordWorkflowEndpointInvocation({ endpoint, payloadHash, source, runId, status });
}

// --- Per-run response endpoints --------------------------------------------
// Slice 1 of the response-egress contract (see specs/run-response-endpoints.md).
// Callers may attach an optional `responseEndpoint` to a run at creation time.
// We store it here, normalized, so delivery (slice 2) can read it back without
// having to scrape the run's `input` field — keeping the raw config out of
// workflow context, logs, and audit detail.

// Insert a new endpoint row attached to `runId`. The caller (HTTP route) is
// responsible for validating type/config first via parseResponseEndpoint;
// this function trusts both fields.
export function createRunResponseEndpoint({ runId, type, config, createdBy = "" }) {
  return runResponseEndpointStore.createRunResponseEndpoint({ runId, type, config, createdBy });
}

export function listRunResponseEndpointsForRun(runId) {
  return runResponseEndpointStore.listRunResponseEndpointsForRun(runId);
}

export function listPendingRunResponseEndpoints(limit = 100) {
  return runResponseEndpointStore.listPendingRunResponseEndpoints(limit);
}

export function updateRunResponseEndpointDelivery(id, updates = {}) {
  return runResponseEndpointStore.updateRunResponseEndpointDelivery(id, updates);
}

export function listAgents(q = "") {
  return catalogStore.listAgents(q);
}

export function getAgent(slug) {
  return catalogStore.getAgent(slug);
}

export function upsertAgent(input) {
  return catalogStore.upsertAgent(input);
}

export function listSkills(q = "") {
  return catalogStore.listSkills(q);
}

export function getSkill(slug) {
  return catalogStore.getSkill(slug);
}

export function upsertSkill(input) {
  return catalogStore.upsertSkill(input);
}

export function listKnowledge(q = "") {
  return catalogStore.listKnowledge(q);
}

export function upsertKnowledge(input) {
  return catalogStore.upsertKnowledge(input);
}

export { approvalPolicyNotifiesTelegram } from "./operatorRecords.js";

export function autoQueueLegacyRunStartApprovals() {
  return operatorStore.autoQueueLegacyRunStartApprovals();
}

export function createRun(capability, input, options = {}) {
  return runCreateStore.createRun(capability, input, options);
}

export function getRun(runId) {
  return runStore.getRun(runId);
}

// Find a still-active supervising run-smithers run by its internal supervision
// token. Used to validate a child run's bypass marker — the token is minted by
// the Hub when it creates a supervising run and is redacted from every API
// response, so only a genuine supervised child (the run-smithers workflow
// echoing the token it received) can present a matching one. Returns the
// supervising run or null.
export function findActiveSupervisorByToken(token, wrappedCapability = "") {
  return runStore.findActiveSupervisorByToken(token, wrappedCapability);
}

export function listRuns({ status = "", limit = 100, q = "", since = "", until = "", cursor = "", capabilitySlugs = [], includeInternal = false } = {}) {
  return runStore.listRuns({ status, limit, q, since, until, cursor, capabilitySlugs, includeInternal });
}

export function countRuns({ status = "", q = "", since = "", until = "", capabilitySlugs = [], includeInternal = false } = {}) {
  return runStore.countRuns({ status, q, since, until, capabilitySlugs, includeInternal });
}

// Distinct `capability_sha` values seen across this capability's runs, with
// first/last timestamps and run counts. Used by GET /api/capabilities/:name/versions
// to surface the rollback target list. Returns an empty array when capability
// versioning has never been enabled (no run ever stored a non-null sha).
export function listCapabilityVersionsFromRuns(slug) {
  return runStore.listCapabilityVersionsFromRuns(slug);
}

// Token id that owns a run, via the runner it was assigned to. Null if unassigned.
export function runOwnerTokenId(runId) {
  return runStore.runOwnerTokenId(runId);
}

export function recordRunLineage(runId, entry = {}) {
  return runSupervisorStore.recordRunLineage(runId, entry);
}

export function listRunLineage(runId) {
  return runSupervisorStore.listRunLineage(runId);
}

export function reconcileRepairChildTerminal(repairRunId) {
  return runSupervisorStore.reconcileRepairChildTerminal(repairRunId);
}

export function reconcileSupervisedChildTerminals(options = {}) {
  return runSupervisorStore.reconcileSupervisedChildTerminals(options);
}

export function reapStuckRunIds(maxMs) {
  return runSupervisorStore.reapStuckRunIds(maxMs);
}

export function reconcileFailedRecoverable(options = {}) {
  return runSupervisorStore.reconcileFailedRecoverable(options);
}

export function reapStuckRuns(maxMs) {
  return runSupervisorStore.reapStuckRuns(maxMs);
}

export function runApprovalHold(run) {
  return runSupervisorStore.runApprovalHold(run);
}

export { normalizeRun };

export function updateRun(runId, updates) {
  return runMutationStore.updateRun(runId, updates);
}

export { canTransitionRun, RUN_TERMINAL };

// Guarded status change. Returns {ok, run, error, code, idempotent, raced}. Re-applying a terminal status is a no-op.
export function transitionRun(runId, toStatus, updates = {}) {
  return runMutationStore.transitionRun(runId, toStatus, updates);
}

export function addRunEvent(runId, type, message = "", data = {}) {
  const result = runStore.addRunEvent(runId, type, message, data);
  // Publish to any live SSE tails (no-op when nobody is subscribed). Additive:
  // does not alter persistence or the return shape.
  emitRunEvent(result);
  return result;
}

export function listRunEvents(runId) {
  return runStore.listRunEvents(runId);
}

export function registerRunner(input, tokenId = null) {
  return runnerStore.registerRunner(input, tokenId);
}

export function runnerIsLive(lastHeartbeatAt) {
  return runnerStore.runnerIsLive(lastHeartbeatAt);
}

export function getRunner(runnerId) {
  return runnerStore.getRunner(runnerId);
}

export function listRunners() {
  return runnerStore.listRunners();
}

export function heartbeatRunner(runnerId, input = {}) {
  return runnerStore.heartbeatRunner(runnerId, input);
}

// Delete runner rows that have been dead longer than `maxMs`. This prunes the
// ghost rows that accumulated before stable-identity registration. Returns the
// list of pruned ids (caller logs the count when >0). A runner with in-flight
// work (active_runs>0 or a non-null current_run_id) is NEVER pruned, even if its
// heartbeat is stale — that work is still being reaped/finished elsewhere.
//
// Datetime comparison MUST go through SQLite's datetime() on both sides: stored
// timestamps are ISO-8601 with `T`/`Z` while a raw string compare against
// datetime('now') (space-separated, no `Z`) miscompares — that exact bug forced
// the manual 95→2 cleanup. datetime() normalizes both to the same form.
export function pruneDeadRunners(maxMs = env.runnerPruneMs) {
  return runnerStore.pruneDeadRunners(maxMs);
}

// Internal helper — adjust a runner's active-run counter atomically. Used by
// claimNextRun (when a slot is taken) and by terminal run transitions (when a
// slot is released). Clamped to >= 0 so a double-release never produces a
// negative counter.
function adjustRunnerActiveRuns(runnerId, delta) {
  return runnerStore.adjustRunnerActiveRuns(runnerId, delta);
}

// Ground-truth in-flight load for a runner, split into the two scheduling pools,
// derived from the durable runs table (NOT the drift-prone active_runs counter).
//   work        — heavy worker runs (the real agents); compete for `capacity`.
//   supervisors — run-smithers envelopes that orchestrate + poll their child.
// Counting supervisors against the work pool is the classic resource deadlock:
// a parent holds a work slot while waiting for a child that can never get one.
// Reading from real state means a crashed/reaped run can never leak a slot —
// the moment its row leaves assigned/running, the slot is free again.
export function runnerLoad(runnerId) {
  return runnerStore.runnerLoad(runnerId);
}

// Size of the separate supervisor pool for a runner of the given work capacity.
// Default ratio 1.0 → up to `capacity` concurrent supervisors, so every work
// slot can host its supervising parent without either starving the other.
export function supervisorPoolSize(capacity) {
  return runnerStore.supervisorPoolSize(capacity);
}

// Recompute every runner's active_runs counter from the durable runs table.
// active_runs is a cached display/drain metric with several writers (claim +1,
// terminal -1, heartbeat overwrite); under crashes or reaper-vs-runner races it
// can drift and falsely read "full". The scheduler no longer trusts it (see
// runnerLoad + claimNextRun), but the dashboard and pruneDeadRunners do, so the
// reaper reconciles it to ground truth each cycle and self-corrects without a
// restart. Returns the runners whose counter was actually corrected.
export function reconcileRunnerActiveRuns() {
  return runnerStore.reconcileRunnerActiveRuns();
}

export function supportRunnerAvailability() {
  const capability = getCapability(SUPPORT_AGENT_CAPABILITY_SLUG);
  return supportRunnerAvailabilityResult({ capability, runners: listRunners() });
}

export function buildAgentRuntimePack(capability) {
  return buildRuntimePack({
    capability,
    getAgent,
    getSkill,
    capturedAt: now()
  });
}

export function claimNextRun(runnerId) {
  return runClaimStore.claimNextRun(runnerId);
}

export { secretNamesForRun } from "./runnerAssignment.js";

// Count of runs that represent in-flight work on a runner (assigned + running).
// This is the metric the updater drains to zero before swapping code — finishing
// in-flight agent work, which (unlike the durable Hub) cannot survive a restart.
export function countActiveRuns() {
  return runMutationStore.countActiveRuns();
}

// Count of runs currently executing. The hub may restart when this is 0 even if
// queued work is waiting (queued/durable work resumes); see decideHubRestart.
export function countRunningRuns() {
  return runMutationStore.countRunningRuns();
}

// --- Operator alerts (_smithers_alerts) -------------------------------------
// Durable, UI-surfaced notices. The self-update flow records its outcome here so
// the admin update badge can show "update failed, rolled back to vX" even though
// the process that performed the update has since restarted.

export function recordAlert({ kind, level = "info", title = "", message = "", data = {} }) {
  return operatorStore.recordAlert({ kind, level, title, message, data });
}

export function listAlerts({ kind = "", limit = 50 } = {}) {
  return operatorStore.listAlerts({ kind, limit });
}

export function latestAlert(kind) {
  return operatorStore.latestAlert(kind);
}

// Counts queued / assigned / running runs — exposed so the Hub UI can render
// a "queue depth" stat without scanning the whole run list.
export function runnerPoolStats() {
  const statusQueries = runnerPoolStatusQueries(VISIBLE_RUN_WHERE);
  const counts = Object.fromEntries(
    Object.entries(statusQueries).map(([key, query]) => [key, one(query.sql, query.params).count])
  );
  const runners = listRunners();
  return runnerPoolSummary({ counts, runners });
}

export function createArtifact({ runId, name, kind = "file", mimeType = "application/octet-stream", sizeBytes = 0, path: filePath, metadata = {} }) {
  return operatorStore.createArtifact({ runId, name, kind, mimeType, sizeBytes, path: filePath, metadata });
}

export function getArtifact(artifactId) {
  return operatorStore.getArtifact(artifactId);
}

export function listArtifacts({ runId = "", q = "" } = {}) {
  return operatorStore.listArtifacts({ runId, q });
}

export function createApproval({
  runId = null,
  title,
  description = "",
  requestedBy = "workflow",
  payload = {},
  timeoutMs = null,
  timeoutAt = null,
  fallback = null
}) {
  return operatorStore.createApproval({ runId, title, description, requestedBy, payload, timeoutMs, timeoutAt, fallback });
}

export function sweepTimedApprovals() {
  return operatorStore.sweepTimedApprovals();
}

export function getApproval(approvalId) {
  return operatorStore.getApproval(approvalId);
}

export function listApprovals(status = "") {
  return operatorStore.listApprovals(status);
}

export function resolveApproval(approvalId, decision, resolvedBy = "api", comment = "") {
  return operatorStore.resolveApproval(approvalId, decision, resolvedBy, comment);
}

export function recordAudit(actor, action, target = null, detail = {}) {
  return operatorStore.recordAudit(actor, action, target, detail);
}

export function listAudit({ limit = 100 } = {}) {
  return operatorStore.listAudit({ limit });
}

// --- Schedules (cron jobs) --------------------------------------------------
// First-class recurring (cron) and one-shot (run_at) triggers. The server-side
// ticker (fireDueSchedules in src/server.js) evaluates due rows and creates
// runs through the same dispatch path as a manual run, so approvals,
// supervision, and audit behave identically. `next_run_at` is the single
// source of truth for "when does this fire next"; we recompute it whenever the
// cron/timezone/run_at changes and after every fire. Missed ticks (Hub was
// down) collapse to a single catch-up fire rather than a backfill storm.

export function createSchedule(input) {
  return scheduleStore.createSchedule(input);
}

export function getSchedule(idValue) {
  return scheduleStore.getSchedule(idValue);
}

export function listSchedules({ includeDisabled = true } = {}) {
  return scheduleStore.listSchedules({ includeDisabled });
}

export function updateSchedule(idValue, updates = {}) {
  return scheduleStore.updateSchedule(idValue, updates);
}

export function setScheduleEnabled(idValue, enabled) {
  return scheduleStore.setScheduleEnabled(idValue, enabled);
}

export function deleteSchedule(idValue) {
  return scheduleStore.deleteSchedule(idValue);
}

export function listDueSchedules(nowIso = now()) {
  return scheduleStore.listDueSchedules(nowIso);
}

// Atomically claim a due schedule for firing. Recomputes next_run_at strictly
// after `nowIso` (so a backlog of missed ticks collapses to a single fire) and
// writes it only if the row still holds the next_run_at we observed — making
// concurrent or overlapping ticks idempotent: exactly one caller gets ok:true
// per due tick. One-shot (run_at) schedules are disabled once they fire.
export function claimScheduleFire(idValue, expectedNextRunAt, nowIso = now()) {
  return scheduleStore.claimScheduleFire(idValue, expectedNextRunAt, nowIso);
}

// Record the outcome of a fire (manual run-now or ticker) on the schedule row
// without touching next_run_at — that is owned by claimScheduleFire.
export function recordScheduleFireResult(idValue, runId, status = "queued", firedAtIso = now()) {
  return scheduleStore.recordScheduleFireResult(idValue, runId, status, firedAtIso);
}

export function dashboardStats() {
  const counts = {};
  for (const table of DASHBOARD_COUNT_TABLES) {
    const query = dashboardCountQuery(table, VISIBLE_RUN_WHERE);
    counts[query.key] = one(query.sql, query.params).count;
  }
  for (const query of [pendingApprovalsCountQuery(), runningRunsCountQuery(VISIBLE_RUN_WHERE)]) {
    counts[query.key] = one(query.sql, query.params).count;
  }
  // Pool / queue breakdown so the UI can render runner capacity and a
  // queue-depth chip without having to fan-out to /api/runners + /api/runs.
  return applyDashboardPoolStats(counts, runnerPoolStats());
}

initDb();
