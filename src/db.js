import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";
import { id, now } from "./ids.js";
import { emitRunEvent } from "./runEventBus.js";
import { hashToken, randomToken } from "./security.js";
import { decrypt as decryptSecret, encrypt as encryptSecret, redactSecrets, secretsEnabled } from "./secretsStore.js";
import {
  canTransitionRun,
  RUN_TERMINAL
} from "./runLifecyclePolicy.js";
import { normalizeCapability } from "./capabilityRecords.js";
import { createCapabilityStore } from "./capabilityStore.js";
import { createWorkflowEndpointStore } from "./workflowEndpointStore.js";
import { createHookProfileStore } from "./hookProfileStore.js";
import { createWorkflowBundleStore } from "./workflowBundleStore.js";
import { createRunResponseEndpointStore } from "./runResponseEndpointStore.js";
import { createAccessTokenStore } from "./accessTokenStore.js";
import { createCatalogStore } from "./catalogStore.js";
import { createDbBootstrap } from "./dbBootstrap.js";
import { DB_SCHEMA_SQL } from "./dbSchema.js";
import { runReapReason } from "./runQueryRecords.js";
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
import { approvalKindFromPayload, approvalResolvedViaFromActor } from "./operatorRecords.js";
import { createOperatorStore } from "./operatorStore.js";
import {
  buildRuntimePack
} from "./runtimePackRecords.js";
import { supportRunnerAvailabilityResult } from "./runnerAssignment.js";
import {
  applyDashboardPoolStats,
  dashboardCountQuery,
  DASHBOARD_COUNT_TABLES,
  normalizeUsageTotalsRow,
  pendingApprovalsCountQuery,
  runningRunsCountQuery,
  usageTotalsQuery
} from "./dashboardStats.js";
import {
  normalizeUsageSummaryTotals,
  normalizeUsageSummaryWorkflowRow,
  usageSummaryBudgetStopsQuery,
  usageSummaryByWorkflowQuery,
  usageSummaryTotalsQuery
} from "./usageSummary.js";
import { createScheduleStore } from "./scheduleStore.js";
import { createWorkItemStore } from "./workItemStore.js";
import { createWorkItemRunSync } from "./workItemRunSync.js";
import { createBoardStore } from "./boardStore.js";
import { createScmStore } from "./scmStore.js";
import { createCiStore } from "./ciStore.js";
import { createRunStore } from "./runStore.js";
import { createRunnerStore } from "./runnerStore.js";
import { createRunCreateStore } from "./runCreateStore.js";
import { createRunDraftStore } from "./runDraftStore.js";
import { createRunMutationStore } from "./runMutationStore.js";
import { createRunClaimStore } from "./runClaimStore.js";
import { createRunUsageStore } from "./runUsageStore.js";
import { runGatewayPin } from "./meteringGateway.js";

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
// The status observer keeps the work board honest: every run status write
// funnels through updateRun, and linked runs move their ticket where the
// mapping is reliable (src/workItemRunSync.js). Lazy reference — the sync is
// composed a few stores below; callbacks only fire at request time.
const runMutationStore = createRunMutationStore({
  one,
  run,
  now,
  getRun,
  adjustRunnerActiveRuns,
  onRunStatusChange: (updatedRun, fromStatus) => {
    workItemRunSync.syncWorkItemForRun(updatedRun, { trigger: "run_status", fromStatus });
    scheduleStore.reconcileRunTerminal(updatedRun);
    // CI fast path: a ci-job/ci-pipeline status change advances its pipeline
    // DAG immediately (the orchestrator's 60s sweep is the restart backstop).
    // Registered by serverComposition AFTER the orchestrator exists; a hub
    // without the CI composition (unit tests, CLI-only use) simply has none.
    if (ciRunStatusObserver) {
      try {
        ciRunStatusObserver(updatedRun, fromStatus);
      } catch (error) {
        console.error("CI run-status observer failed:", error.message);
      }
    }
  }
});

let ciRunStatusObserver = null;
export function setCiRunStatusObserver(fn) {
  ciRunStatusObserver = typeof fn === "function" ? fn : null;
}
const runClaimStore = createRunClaimStore({
  run,
  now,
  getRunner,
  runnerLoad,
  listRuns,
  getCapability,
  adjustRunnerActiveRuns,
  addRunEvent,
  getRun,
  getDecryptedSecretEnv,
  buildAgentRuntimePack,
  buildRunGatewayPin: (claimedRun, capability) => runGatewayPin({ run: claimedRun, capability, secret: env.sessionSecret }),
  getWorkflowBundle
});
const runUsageStore = createRunUsageStore({
  all,
  one,
  run,
  id,
  now,
  getRun,
  updateRun,
  addRunEvent
});
const runCreateStore = createRunCreateStore({
  run,
  id,
  now,
  scrubStoredSecrets,
  addRunEvent,
  createApproval,
  getRun,
  getWorkItem,
  addWorkItemEvent,
  syncWorkItemForRun: (createdRun, options) => workItemRunSync.syncWorkItemForRun(createdRun, options)
});
const runDraftStore = createRunDraftStore({
  all,
  one,
  run,
  id,
  now,
  scrubStoredSecrets
});
const runnerStore = createRunnerStore({
  all,
  one,
  run,
  id,
  now,
  runnerOfflineMs: env.runnerOfflineMs,
  runnerPruneMs: env.runnerPruneMs
});
const operatorStore = createOperatorStore({ all, one, run, id, now, addRunEvent, getRun, updateRun });
const scheduleStore = createScheduleStore({
  all,
  one,
  run,
  id,
  now,
  getCapability,
  recordAudit
});
const workItemStore = createWorkItemStore({ all, one, run, id, now });
const workItemRunSync = createWorkItemRunSync({ getWorkItem, updateWorkItem, listWorkItemRuns });
const boardStore = createBoardStore({ all, one, run, id, now });
const scmStore = createScmStore({ all, one, run, id, now });
const ciStore = createCiStore({ all, one, run, id, now });
const workflowEndpointStore = createWorkflowEndpointStore({ all, one, run, id, now, hashToken });
const hookProfileStore = createHookProfileStore({ all, one, run, id, now });
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
  publishWorkflowBundle,
  listWorkflowBundles,
  upsertWorkflowEndpoint
});

export function initDb() {
  db.exec(DB_SCHEMA_SQL);

  migrateRunnersPoolColumns();
  migrateCapabilitySupervisionColumn();
  migrateCapabilityDeadlineColumn();
  migrateCapabilityDefinitionHashColumn();
  migrateRunsCapabilityVersioningColumns();
  migrateRunsUsageBudgetColumns();
  migrateRunsPauseColumn();
  migrateRunsWorkItemColumn();
  migrateSchedulesDisabledReasonColumn();
  migrateRunnerAuthHealthColumn();
  migrateRunsSupervisorColumns();
  migrateApprovalsTimerColumns();
  migrateApprovalsTelegramMessageColumn();
  migrateApprovalsKindResolutionColumns();
  migrateApprovalsAskColumn();
  dbBootstrap.setSettingDefault("instance_name", env.instanceName);
  dbBootstrap.seedCatalog();
  dbBootstrap.seedWorkflowEndpoints();
  dbBootstrap.ensureBootstrapToken();
  boardStore.ensureDefaultBoard({ instanceName: env.instanceName });
  reconcileScheduleReferences("startup");
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

// Metered model-call usage aggregate + optional spend budget. Both nullable —
// NULL until the first usage record arrives / when no budget was requested —
// so existing rows and rollbacks are unaffected. Detail rows live in the
// additive run_usage_records table (created by DB_SCHEMA_SQL).
function migrateRunsUsageBudgetColumns() {
  migrateMissingColumns("runs", [
    { name: "usage", definition: "usage TEXT" },
    { name: "budget", definition: "budget TEXT" }
  ]);
}

// First-class paused runs (recoverable external interruption, e.g. credits
// exhausted). JSON blob built by src/runPause.js: {reason, message, pausedAt,
// pausedBy, resumable, resume, requiredAction, resumedAt?, resumedBy?}.
// Nullable — NULL until a run first pauses — so existing rows and rollbacks
// are unaffected.
function migrateRunsPauseColumn() {
  migrateMissingColumns("runs", [
    { name: "pause", definition: "pause TEXT" }
  ]);
}

// Work-item ("ticket") linkage: which durable work item a run is executing
// for. Nullable — NULL means the run is unlinked (every pre-existing run) —
// so existing rows and rollbacks are unaffected. The index is created here,
// not in DB_SCHEMA_SQL, because on existing installs the column only exists
// after this ALTER runs.
function migrateRunsWorkItemColumn() {
  migrateMissingColumns("runs", [
    { name: "work_item_id", definition: "work_item_id TEXT" }
  ]);
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_work_item ON runs(work_item_id)");
}

function migrateSchedulesDisabledReasonColumn() {
  migrateMissingColumns("schedules", [
    { name: "disabled_reason", definition: "disabled_reason TEXT NOT NULL DEFAULT ''" }
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

// Historical run accounting columns kept for existing SQLite files. The
// supervisor runtime that used them has been removed.
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

function migrateApprovalsTelegramMessageColumn() {
  migrateMissingColumns("approvals", [{ name: "telegram_message", definition: "telegram_message TEXT" }]);
}

// The ask contract (audience/action/reason/options, JSON). Nullable and never
// backfilled: a historical card whose creator never declared a question keeps
// ask=NULL and is presented with an explicitly-derived fallback ask — we do
// not invent asks after the fact.
function migrateApprovalsAskColumn() {
  migrateMissingColumns("approvals", [{ name: "ask", definition: "ask TEXT" }]);
}

// The honest approval lifecycle (kind + resolution + resolved_via). Runs the
// backfill exactly once per existing install — only when the ALTERs actually
// add the columns (fresh installs get them, with CHECK constraints, from the
// CREATE TABLE and never enter the backfill branch):
// - kind is inferred from the payload conventions creators already used
//   (engine_approval/checkpoint/child_run_approval -> workflow_gate,
//   supervisor_escalation -> escalation, anything else -> custom).
// - Historical resolved rows move to status='resolved' with resolution taken
//   from the old decision column (falling back to the old status), and
//   resolved_via inferred from the resolver actor string.
// - Legacy pending run_start/workflow_start cards are auto-queued one final
//   time; the standing per-boot auto-queue is retired with this migration
//   (run-start approvals are a retired concept — nothing creates them).
function migrateApprovalsKindResolutionColumns() {
  const query = tableColumnsQuery("approvals");
  const existingColumns = all(query.sql, query.params).map((row) => row.name);
  if (existingColumns.includes("kind")) return;

  migrateMissingColumns("approvals", [
    { name: "kind", definition: "kind TEXT NOT NULL DEFAULT 'custom'" },
    { name: "resolution", definition: "resolution TEXT" },
    { name: "resolved_via", definition: "resolved_via TEXT" }
  ]);

  for (const row of all("SELECT id, payload FROM approvals")) {
    const kind = approvalKindFromPayload(parseJson(row.payload, {}));
    if (kind !== "custom") run("UPDATE approvals SET kind=? WHERE id=?", [kind, row.id]);
  }

  const legacyResolved = all("SELECT id, status, decision, resolved_by FROM approvals WHERE status NOT IN ('pending', 'resolved')");
  for (const row of legacyResolved) {
    const decision = ["approved", "rejected", "changes_requested"].includes(row.decision) ? row.decision : null;
    const resolution = decision || (row.status === "approved" ? "approved" : "rejected");
    run("UPDATE approvals SET status='resolved', resolution=?, resolved_via=? WHERE id=?", [
      resolution,
      approvalResolvedViaFromActor(row.resolved_by),
      row.id
    ]);
  }

  operatorStore.autoQueueLegacyRunStartApprovals();
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
  const existing = input?.slug ? getCapability(input.slug) : null;
  const disablesCapability = input?.enabled === false || input?.enabled === 0;
  if (existing?.enabled && disablesCapability) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const capability = capabilityStore.upsertCapability(input);
      if (capability && !capability.enabled) {
        const reason = `workflow "${capability.slug}" was disabled`;
        scheduleStore.autoDisableSchedulesForCapability(capability.slug, reason, "system");
      }
      db.exec("COMMIT");
      return capability;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const capability = capabilityStore.upsertCapability(input);
  if (capability && existing?.enabled && !capability.enabled) {
    const reason = `workflow "${capability.slug}" was disabled`;
    scheduleStore.autoDisableSchedulesForCapability(capability.slug, reason, "system");
  }
  return capability;
}

export function deleteCapability(slugOrId) {
  const existing = getCapability(slugOrId);
  if (existing?.enabled) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const deleted = capabilityStore.deleteCapability(slugOrId);
      if (deleted) {
        const reason = `workflow "${deleted.slug}" was disabled`;
        scheduleStore.autoDisableSchedulesForCapability(deleted.slug, reason, "system");
      }
      db.exec("COMMIT");
      return deleted;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const deleted = capabilityStore.deleteCapability(slugOrId);
  return deleted;
}

// --- Post-run hook profiles ---------------------------------------------
// Admin-authored recipes for optional post-run side effects. Mutations are
// admin-gated at the route layer; discovery filters to enabled profiles.

export function listHookProfiles({ includeDisabled = false } = {}) {
  return hookProfileStore.listHookProfiles({ includeDisabled });
}

export function getHookProfile(slugOrId) {
  return hookProfileStore.getHookProfile(slugOrId);
}

export function upsertHookProfile(input) {
  return hookProfileStore.upsertHookProfile(input);
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

// --- Run drafts (run-creation negotiation) -----------------------------------
// Proposed runs that have NOT been enqueued; see runDraftStore.js. Draft input
// passes through scrubStoredSecrets like run input, so a pasted secret never
// persists in a draft either.

export function createRunDraft(input) {
  return runDraftStore.createRunDraft(input);
}

export function getRunDraft(draftId) {
  return runDraftStore.getRunDraft(draftId);
}

export function listRunDrafts(options = {}) {
  return runDraftStore.listRunDrafts(options);
}

export function updateRunDraft(draftId, patch = {}) {
  return runDraftStore.updateRunDraft(draftId, patch);
}

export function markRunDraftSubmitted(draftId, options = {}) {
  return runDraftStore.markRunDraftSubmitted(draftId, options);
}

export function discardRunDraft(draftId) {
  return runDraftStore.discardRunDraft(draftId);
}

export function getRun(runId) {
  return runStore.getRun(runId);
}

export function listRuns({ status = "", limit = 100, q = "", since = "", until = "", cursor = "", capabilitySlugs = [], workItemId = "", includeInternal = false } = {}) {
  return runStore.listRuns({ status, limit, q, since, until, cursor, capabilitySlugs, workItemId, includeInternal });
}

export function countRuns({ status = "", q = "", since = "", until = "", capabilitySlugs = [], workItemId = "", includeInternal = false } = {}) {
  return runStore.countRuns({ status, q, since, until, capabilitySlugs, workItemId, includeInternal });
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

export function reconcileRepairChildTerminal(repairRunId) {
  return null;
}

export function reapStuckRunIds(maxMs) {
  const rows = all(`SELECT runs.id,
            runs.runner_id,
            runs.status,
            runs.capability_slug,
            runs.input,
            runs.created_at,
            runs.assigned_at,
            runs.started_at,
            runners.last_heartbeat_at,
            (SELECT MAX(created_at) FROM run_events WHERE run_id = runs.id) AS last_event_at
       FROM runs
       LEFT JOIN runners ON runners.id = runs.runner_id
      WHERE runs.status IN ('assigned','running','waiting_approval')`);
  const reaped = [];
  const nowMs = Date.now();
  for (const row of rows) {
    const reason = runReapReason(row, {
      maxMs,
      stallMs: env.runStallMs,
      runnerOfflineMs: env.runnerOfflineMs,
      nowMs,
      hasPendingApproval,
      hasEngineApprovalWait
    });
    if (!reason) continue;
    const result = transitionRun(row.id, "failed", {
      current_step: reason.currentStep,
      error: reason.error,
      completed_at: now()
    });
    if (!result.ok || result.idempotent) continue;
    addRunEvent(row.id, "run.failed", reason.message, { reason: reason.reason });
    reaped.push(row.id);
  }
  return reaped;
}

export function reapStuckRuns(maxMs) {
  return reapStuckRunIds(maxMs).length;
}

function hasPendingApproval(runId) {
  if (!runId) return false;
  return Boolean(one("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1", [String(runId)]));
}

function engineApprovalHoldFromEvents(rows = []) {
  const seen = new Set();
  for (const row of rows) {
    const nodeId = String(parseJson(row?.data, {})?.nodeId ?? "");
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (row?.type === "engine.approval.waiting") return true;
  }
  return false;
}

export function runApprovalHold(run) {
  if (!run?.id) return false;
  return hasPendingApproval(run.id) || hasEngineApprovalWait(run.id);
}

export function hasEngineApprovalWait(runId) {
  if (!runId) return false;
  const rows = all(`SELECT type, data FROM run_events
      WHERE run_id = ? AND type IN ('engine.approval.waiting', 'engine.approval.resumed')
      ORDER BY created_at DESC, rowid DESC LIMIT 200`, [String(runId)]);
  return engineApprovalHoldFromEvents(rows);
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

export function recordRunUsage(runId, body) {
  return runUsageStore.recordRunUsage(runId, body);
}

export function getRunUsage(runId) {
  return runUsageStore.getRunUsage(runId);
}

export function listRunUsageRecords(runId, options = {}) {
  return runUsageStore.listRunUsageRecords(runId, options);
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

// Ground-truth in-flight load for a runner, derived from the durable runs table
// rather than the drift-prone active_runs counter.
export function runnerLoad(runnerId) {
  return runnerStore.runnerLoad(runnerId);
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
  ask = null,
  payload = {},
  timeoutMs = null,
  timeoutAt = null,
  fallback = null
}) {
  return operatorStore.createApproval({ runId, title, description, requestedBy, ask, payload, timeoutMs, timeoutAt, fallback });
}

export function sweepTimedApprovals() {
  return operatorStore.sweepTimedApprovals();
}

export function sweepSupersededApprovals() {
  return operatorStore.sweepSupersededApprovals();
}

export function setApprovalTelegramMessage(approvalId, telegramMessage = null) {
  return operatorStore.setApprovalTelegramMessage(approvalId, telegramMessage);
}

export function getApproval(approvalId) {
  return operatorStore.getApproval(approvalId);
}

export function listApprovals(status = "") {
  return operatorStore.listApprovals(status);
}

export function resolveApproval(approvalId, decision, resolvedBy = "api", comment = "", resolvedVia = "human") {
  return operatorStore.resolveApproval(approvalId, decision, resolvedBy, comment, resolvedVia);
}

export function resolveEngineApprovalOnResume(runId, data = {}) {
  return operatorStore.resolveEngineApprovalOnResume(runId, data);
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

export function autoDisableSchedule(idValue, reason, actor = "system") {
  return scheduleStore.autoDisableSchedule(idValue, reason, actor);
}

export function reconcileScheduleReferences(actor = "system") {
  return scheduleStore.reconcileScheduleReferences(actor);
}

// --- Work items (tickets) ----------------------------------------------------
// Durable company work objects: the unit a human plans and tracks, distinct
// from workflows (recipes) and runs (execution attempts). Runs attach via the
// nullable runs.work_item_id column; a work item aggregates its runs but never
// inherits a run's failure as its own state.

export function createWorkItem(input) {
  return workItemStore.createWorkItem(input);
}

export function getWorkItem(idValue) {
  return workItemStore.getWorkItem(idValue);
}

export function listWorkItems(filters = {}) {
  return workItemStore.listWorkItems(filters);
}

export function updateWorkItem(idValue, updates = {}, options = {}) {
  return workItemStore.updateWorkItem(idValue, updates, options);
}

export function deleteWorkItem(idValue) {
  return workItemStore.deleteWorkItem(idValue);
}

export function addWorkItemEvent(workItemId, type, message = "", data = {}) {
  return workItemStore.addWorkItemEvent(workItemId, type, message, data);
}

export function listWorkItemEvents(workItemId, limit = 200) {
  return workItemStore.listWorkItemEvents(workItemId, limit);
}

export function listWorkItemRuns(workItemId) {
  return workItemStore.listWorkItemRuns(workItemId);
}

export function linkRunToWorkItem(workItemId, runId, options = {}) {
  return workItemStore.linkRunToWorkItem(workItemId, runId, options);
}

export function unlinkRunFromWorkItem(workItemId, runId, options = {}) {
  return workItemStore.unlinkRunFromWorkItem(workItemId, runId, options);
}

export function workItemRunSummaries() {
  return workItemStore.workItemRunSummaries();
}

export function syncWorkItemForRun(runRecord, options = {}) {
  return workItemRunSync.syncWorkItemForRun(runRecord, options);
}

export function listBoards() {
  return boardStore.listBoards();
}

export function getBoard(slugOrId) {
  return boardStore.getBoard(slugOrId);
}

export function createBoard(input) {
  return boardStore.createBoard(input);
}

export function updateBoard(slugOrId, updates = {}) {
  return boardStore.updateBoard(slugOrId, updates);
}

// Windowed cross-run usage rollup behind GET /api/usage/summary: fleet totals,
// a per-workflow breakdown (highest spend first), and how many runs hit their
// budget in the window. Same visibility rules as every other run read.
export function usageSummary({ since }) {
  const sinceIso = String(since || "");
  return {
    totals: normalizeUsageSummaryTotals(one(usageSummaryTotalsQuery(VISIBLE_RUN_WHERE).sql, [sinceIso])),
    byWorkflow: all(usageSummaryByWorkflowQuery(VISIBLE_RUN_WHERE).sql, [sinceIso]).map(normalizeUsageSummaryWorkflowRow),
    budgetStopped: Number(one(usageSummaryBudgetStopsQuery(VISIBLE_RUN_WHERE).sql, [sinceIso]).count) || 0
  };
}

// --- SCM connections + CI pipelines (see specs/ci-platform.md) --------------

export function getScmInstallation(installationId, options = {}) {
  return scmStore.getScmInstallation(installationId, options);
}

export function listScmInstallations() {
  return scmStore.listScmInstallations();
}

export function upsertScmInstallation(input) {
  return scmStore.upsertScmInstallation(input);
}

export function getScmRepo(idOrFullName, options = {}) {
  return scmStore.getScmRepo(idOrFullName, options);
}

export function listScmRepos(options = {}) {
  return scmStore.listScmRepos(options);
}

export function upsertScmRepo(input) {
  return scmStore.upsertScmRepo(input);
}

export function setScmRepoEnabled(repoId, enabled) {
  return scmStore.setScmRepoEnabled(repoId, enabled);
}

export function setScmRepoTrustPolicy(repoId, trustPolicy) {
  return scmStore.setScmRepoTrustPolicy(repoId, trustPolicy);
}

export function findScmWebhookDelivery(deliveryId, options = {}) {
  return scmStore.findScmWebhookDelivery(deliveryId, options);
}

export function recordScmWebhookDelivery(input) {
  return scmStore.recordScmWebhookDelivery(input);
}

export function listScmWebhookDeliveries(options = {}) {
  return scmStore.listScmWebhookDeliveries(options);
}

export function countScmWebhookDeliveries(options = {}) {
  return scmStore.countScmWebhookDeliveries(options);
}

export function pruneScmWebhookDeliveries(cutoffIso) {
  return scmStore.pruneScmWebhookDeliveries(cutoffIso);
}

export function createCiPipeline(input) {
  return ciStore.createCiPipeline(input);
}

export function getCiPipeline(pipelineId) {
  return ciStore.getCiPipeline(pipelineId);
}

export function getCiPipelineByRunId(runId) {
  return ciStore.getCiPipelineByRunId(runId);
}

export function listCiPipelines(options = {}) {
  return ciStore.listCiPipelines(options);
}

export function listActiveCiPipelines(options = {}) {
  return ciStore.listActiveCiPipelines(options);
}

export function setCiPipelineRun(pipelineId, runId) {
  return ciStore.setCiPipelineRun(pipelineId, runId);
}

export function markCiPipelineSuperseded(pipelineId, supersededBy) {
  return ciStore.markCiPipelineSuperseded(pipelineId, supersededBy);
}

export function setCiPipelineTested(pipelineId, tested) {
  return ciStore.setCiPipelineTested(pipelineId, tested);
}

export function listRecentCiPipelines(options = {}) {
  return ciStore.listRecentCiPipelines(options);
}

export function findCiJobRunCandidate(parentRunId, jobId) {
  return ciStore.findCiJobRunCandidate(parentRunId, jobId);
}

export function lastCiRunEventAt(runId) {
  return ciStore.lastCiRunEventAt(runId);
}

export function updateCiPipelineCheck(pipelineId, updates = {}) {
  return ciStore.updateCiPipelineCheck(pipelineId, updates);
}

export function getCiJob(jobId) {
  return ciStore.getCiJob(jobId);
}

export function getCiJobByRunId(runId) {
  return ciStore.getCiJobByRunId(runId);
}

export function listCiJobs(pipelineId) {
  return ciStore.listCiJobs(pipelineId);
}

export function markCiJobDispatched(jobId, runId) {
  return ciStore.markCiJobDispatched(jobId, runId);
}

export function markCiJobPhase(jobId, phase, reason = "") {
  return ciStore.markCiJobPhase(jobId, phase, reason);
}

export function updateCiJobCheck(jobId, updates = {}) {
  return ciStore.updateCiJobCheck(jobId, updates);
}

export function countPendingApprovals() {
  const query = pendingApprovalsCountQuery();
  return Number(one(query.sql, query.params).count) || 0;
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
  const usageQuery = usageTotalsQuery(VISIBLE_RUN_WHERE);
  counts[usageQuery.key] = normalizeUsageTotalsRow(one(usageQuery.sql, usageQuery.params));
  // Pool / queue breakdown so the UI can render runner capacity and a
  // queue-depth chip without having to fan-out to /api/runners + /api/runs.
  return applyDashboardPoolStats(counts, runnerPoolStats());
}

initDb();
