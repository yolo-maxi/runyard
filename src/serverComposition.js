import { withAgentLinks, withArtifactLinks, withCapabilityLinks } from "./deepLinks.js";
import { subscribeRunEvents } from "./runEventBus.js";
import { presentRunResponseEndpoint } from "./runResponseEndpoint.js";
import { scheduleRunResponseEndpointDelivery } from "./runResponseEndpointDelivery.js";
import { createRunTerminalArtifactService } from "./runTerminalArtifacts.js";
import { summarizeRunEvents } from "./runEventSummary.js";
import { chatWithSupportAgent, supportAgentInfo } from "./runyardSupportAgent.js";
import { buildSupportLiveContext } from "./supportContext.js";
import { timingSafeEqualStr } from "./security.js";
import {
  authenticateTelegramWebAppSession,
  createTelegramWebAppSession,
  telegramSessionCanAccess,
  telegramUserLabel,
  verifyTelegramWebAppInitData
} from "./telegramWebAppAuth.js";
import { sanitizeForDisplay } from "./approvalPresentation.js";
import { createRunDispatcher } from "./runDispatch.js";
import { createRunPreflightEvaluator } from "./runPreflight.js";
import { createRunDraftHandlers } from "./runDraftRoutes.js";
import { createSecretHandlers } from "./secretsRoutes.js";
import { createTokenHandlers } from "./tokenRoutes.js";
import { maybeRecordFailureClassAlert as maybeRecordFailureAlert } from "./failureAlerts.js";
import { createWorkflowEndpointHandlers } from "./workflowEndpointRoutes.js";
import { createHookProfileHandlers } from "./hookProfileRoutes.js";
import { createWorkflowBundleHandlers } from "./workflowBundleRoutes.js";
import { createWorkflowPackageHandlers } from "./workflowPackageRoutes.js";
import { createRunLifecycleHandlers } from "./runLifecycleRoutes.js";
import { createRunReadHandlers } from "./runReadRoutes.js";
import { createGatewayHandlers } from "./gatewayRoutes.js";
import { createRunBudgetEnforcer } from "./runBudget.js";
import { createRunPauseStore } from "./runPauseStore.js";
import { now } from "./ids.js";
import { createRunPromotionHandlers } from "./runPromotionRoutes.js";
import { createCapabilityHandlers } from "./capabilityRoutes.js";
import { createScheduleHandlers } from "./scheduleRoutes.js";
import { createWorkItemHandlers } from "./workItemRoutes.js";
import { createBoardHandlers } from "./boardRoutes.js";
import { createBoardDefinitionHandlers } from "./boardDefinitionRoutes.js";
import {
  deriveWorkflowGraph,
  deriveWorkflowGraphFromMetadata,
  loadWorkflowSource
} from "./workflowSource.js";
import { createCatalogHandlers } from "./catalogRoutes.js";
import { createApprovalHandlers } from "./approvalHttpRoutes.js";
import { createArtifactHandlers } from "./artifactRoutes.js";
import { createSupportChatHandlers } from "./supportChatRoutes.js";
import { createRunRerunHandlers } from "./runRerunRoutes.js";
import { createUpdateHandlers } from "./selfUpdateRoutes.js";
import { createAdminReadHandlers } from "./adminReadRoutes.js";
import { createAuthHandlers } from "./authRoutes.js";
import { createPublicHandlers } from "./publicRoutes.js";
import { createOperatorReadHandlers } from "./operatorReadRoutes.js";
import { createTelegramApprovalNotifier } from "./telegramApprovalNotifier.js";
import { createAuthMiddleware } from "./authMiddleware.js";
import { createServerPresentation } from "./serverPresentation.js";
import { createGitHubApp } from "./githubApp.js";
import { createCiTriggers } from "./ciTriggers.js";
import { createCiOrchestrator } from "./ciOrchestrator.js";
import { createCiReporter } from "./ciReporter.js";
import { createGithubWebhookHandlers } from "./githubWebhooks.js";
import { createCiHandlers } from "./ciRoutes.js";

export function createServerComposition({
  db,
  env,
  getUpdateChecker,
  getVersionInfo,
  processEnv = process.env,
  startedAt = Date.now()
}) {
  const {
    addRunEvent,
    authenticateToken,
    createAccessToken,
    createApproval,
    createArtifact,
    createRun,
    DEFAULT_HIDDEN_RUN_SLUGS,
    countPendingApprovals,
    countWorkflowEndpointInvocations,
    dashboardStats,
    findRecentWorkflowEndpointInvocation,
    getArtifact,
    getApproval,
    getCapability,
    getWorkflowBundle,
    getWorkflowEndpoint,
    countRuns,
    createRunDraft,
    createRunResponseEndpoint,
    createSchedule,
    autoDisableSchedule,
    listSchedules,
    getSchedule,
    updateSchedule,
    setScheduleEnabled,
    deleteCapability,
    deleteSchedule,
    listDueSchedules,
    claimScheduleFire,
    recordScheduleFireResult,
    getDecryptedSecretEnv,
    getRun,
    getRunner,
    getRunDraft,
    getRunUsage,
    recordRunUsage,
    discardRunDraft,
    listRunDrafts,
    markRunDraftSubmitted,
    updateRunDraft,
    getHookProfile,
    listHookProfiles,
    listRunners,
    upsertHookProfile,
    listRunResponseEndpointsForRun,
    listAccessTokens,
    listAgents,
    listApprovals,
    listAudit,
    listArtifacts,
    listCapabilities,
    listCapabilityVersionsFromRuns,
    listKnowledge,
    listRunEvents,
    listRuns,
    listSkills,
    listWorkflowBundles,
    listWorkflowEndpoints,
    pruneDeadRunners,
    publishWorkflowBundle,
    reapStuckRunIds,
    reconcileRepairChildTerminal,
    reconcileRunnerActiveRuns,
    runApprovalHold,
    recordWorkflowEndpointInvocation,
    recordAudit,
    resolveApproval,
    resolveEngineApprovalOnResume,
    revokeAccessToken,
    runOwnerTokenId,
    runnerPoolStats,
    transitionRun,
    upsertAgent,
    upsertCapability,
    upsertKnowledge,
    upsertSkill,
    upsertWorkflowEndpoint,
    updateRun,
    usageSummary,
    listSecretMeta,
    secretExists,
    upsertSecret,
    deleteSecret,
    secretsEnabled,
    scrubStoredSecrets,
    recordAlert,
    listAlerts,
    latestAlert,
    setApprovalTelegramMessage,
    sweepSupersededApprovals,
    sweepTimedApprovals,
    createWorkItem,
    deleteWorkItem,
    getWorkItem,
    linkRunToWorkItem,
    listWorkItemEvents,
    listWorkItemRuns,
    listWorkItems,
    unlinkRunFromWorkItem,
    updateWorkItem,
    workItemRunSummaries,
    syncWorkItemForRun,
    listBoards,
    getBoard,
    createBoard,
    updateBoard,
    // CI platform (specs/ci-platform.md)
    getScmInstallation,
    listScmInstallations,
    upsertScmInstallation,
    getScmRepo,
    listScmRepos,
    upsertScmRepo,
    setScmRepoEnabled,
    setScmRepoTrustPolicy,
    findScmWebhookDelivery,
    recordScmWebhookDelivery,
    listScmWebhookDeliveries,
    countScmWebhookDeliveries,
    pruneScmWebhookDeliveries,
    createCiPipeline,
    getCiPipeline,
    getCiPipelineByRunId,
    listCiPipelines,
    listActiveCiPipelines,
    listRecentCiPipelines,
    markCiPipelineSuperseded,
    setCiPipelineRun,
    getCiJob,
    getCiJobByRunId,
    listCiJobs,
    markCiJobDispatched,
    markCiJobPhase,
    findCiJobRunCandidate,
    lastCiRunEventAt,
    updateCiJobCheck,
    updateCiPipelineCheck,
    setCiRunStatusObserver
  } = db;

  // Static workflow graph for a run's capability, for the flow view. Falls
  // back to the metadata-derived two-node graph, then to null (src/runFlow.js
  // degrades to an event-derived stepper). Never throws: a missing bundle is
  // a source-browsing error, not a reason to hide observed execution.
  const runWorkflowGraph = (run) => {
    const capability = getCapability(run.capabilitySlug);
    if (!capability) return null;
    try {
      const source = loadWorkflowSource(capability, { root: env.root, getWorkflowBundle });
      if (source) return deriveWorkflowGraph(source.code, capability);
    } catch {
      // fall through to the metadata graph
    }
    return deriveWorkflowGraphFromMetadata(capability);
  };

  const pendingApprovalsForRun = (runId) =>
    listApprovals("pending").filter((approval) => approval.runId === runId);

  const {
    approvalContext,
    decorateSingleRun,
    runDiagnostics,
    withApprovalLinks,
    withRunLinks
  } = createServerPresentation({
    getCapability,
    getRun,
    listApprovals,
    listRuns,
    sanitizeForDisplay,
    withArtifactLinks
  });

  const {
    dispatchRunResponseEndpointDelivery,
    recordRunTerminalArtifacts,
    reapStuckRunsWithRetrospectives,
    storeRunArtifact
  } = createRunTerminalArtifactService({
    env,
    createArtifact,
    getRun,
    listArtifacts,
    listRunEvents,
    getCapability,
    withArtifactLinks,
    withRunLinks,
    withCapabilityLinks,
    summarizeRunEvents,
    runDiagnostics,
    scrubStoredSecrets,
    addRunEvent,
    scheduleRunResponseEndpointDelivery,
    reconcileRepairChildTerminal,
    reapStuckRunIds
  });

  const dispatchRun = createRunDispatcher({
    createRun
  });

  // Deterministic run-creation preflight shared by /preflight, negotiate-mode
  // create, and the run-draft negotiation flow. Binds live Hub state once.
  const evaluatePreflight = createRunPreflightEvaluator({
    listRunners,
    listHookProfiles,
    secretExists,
    secretsEnabled,
    getWorkflowBundle,
    root: env.root,
    env: processEnv
  });

  const {
    answerTelegramCallbackQuery,
    clearTelegramApprovalButtons,
    notifyTelegram,
    telegramApprovalTarget,
    updateStoredTelegramApprovalMessage,
    updateTelegramApprovalMessage
  } = createTelegramApprovalNotifier({
    approvalContext,
    env,
    getCapability,
    getRun,
    setApprovalTelegramMessage
  });

  function sweepTimedApprovalsAndUpdateTelegram() {
    const swept = sweepTimedApprovals();
    for (const entry of swept) {
      const approval = getApproval(entry.id);
      if (!approval?.telegramMessage) continue;
      updateStoredTelegramApprovalMessage(approval).catch((error) => {
        console.error("Telegram approval expiry update failed:", error.message);
      });
    }
    return swept;
  }

  const maybeRecordFailureClassAlert = (status) =>
    maybeRecordFailureAlert(status, { countRuns, latestAlert, recordAlert });

  const workflowEndpointHandlers = createWorkflowEndpointHandlers({
    addRunEvent,
    countWorkflowEndpointInvocations,
    createRun,
    findRecentWorkflowEndpointInvocation,
    getCapability,
    getRun,
    getWorkflowEndpoint,
    listWorkflowEndpoints,
    recordAudit,
    recordWorkflowEndpointInvocation,
    upsertWorkflowEndpoint,
    withRunLinks
  });

  const workflowBundleHandlers = createWorkflowBundleHandlers({
    getWorkflowBundle,
    listWorkflowBundles,
    publishWorkflowBundle,
    recordAudit
  });

  const workflowPackageHandlers = createWorkflowPackageHandlers({
    getCapability,
    getWorkflowBundle,
    publishWorkflowBundle,
    recordAudit,
    root: env.root,
    deleteCapability,
    upsertCapability,
    env
  });

  // Budget hard-stop shared by the usage-ingest endpoint and the metering
  // gateway: both enforce after every accepted record (and the gateway also
  // pre-checks before forwarding upstream).
  const { enforceRunBudget } = createRunBudgetEnforcer({
    getRun,
    addRunEvent,
    transitionRun,
    recordRunTerminalArtifacts,
    now
  });

  // Pause/resume domain ops shared by the run lifecycle endpoints and the
  // metering gateway's provider credit-exhaustion hook.
  const runPause = createRunPauseStore({
    getRun,
    getRunner,
    transitionRun,
    updateRun,
    addRunEvent,
    now
  });

  const runLifecycleHandlers = createRunLifecycleHandlers({
    addRunEvent,
    createRun,
    enforceRunBudget,
    runPause,
    getCapability,
    maybeRecordFailureClassAlert,
    recordRunTerminalArtifacts,
    recordRunUsage,
    resolveEngineApprovalOnResume,
    scrubStoredSecrets,
    transitionRun,
    updateRun,
    withRunLinks
  });

  const gatewayHandlers = createGatewayHandlers({
    env,
    processEnv,
    getRun,
    getCapability,
    getDecryptedSecretEnv,
    recordRunUsage,
    enforceRunBudget,
    pauseRun: runPause.pauseRun
  });

  const runReadHandlers = createRunReadHandlers({
    countPendingApprovals,
    countRuns,
    decorateSingleRun,
    getRun,
    getRunUsage,
    getWorkItem,
    hiddenRunSlugs: DEFAULT_HIDDEN_RUN_SLUGS,
    listArtifacts,
    listRunEvents,
    listRunResponseEndpointsForRun,
    listRuns,
    pendingApprovalsForRun,
    presentRunResponseEndpoint,
    reapStuckRunsWithRetrospectives,
    runApprovalHold,
    runDeadlineMs: () => env.runDeadlineMs,
    runDiagnostics,
    runnerPoolStats,
    runTimelineEnabled: () => env.runTimelineEnabled,
    runWorkflowGraph,
    subscribeRunEvents,
    usageSummary,
    withArtifactLinks,
    withRunLinks
  });

  const runRerunHandlers = createRunRerunHandlers({
    addRunEvent,
    dispatchRun,
    getCapability,
    getRun,
    listApprovals,
    listRuns,
    notifyTelegram,
    withRunLinks
  });

  const runPromotionHandlers = createRunPromotionHandlers({
    addRunEvent,
    getRun,
    scrubStoredSecrets,
    updateRun,
    withRunLinks
  });

  const capabilityHandlers = createCapabilityHandlers({
    addRunEvent,
    createRunDraft,
    createRunResponseEndpoint,
    dispatchRun,
    evaluatePreflight,
    getCapability,
    getWorkItem,
    getWorkflowBundle,
    publishWorkflowBundle,
    listApprovals,
    listCapabilities,
    listCapabilityVersionsFromRuns,
    listHookProfiles,
    notifyTelegram,
    recordAudit,
    root: env.root,
    deleteCapability,
    upsertCapability,
    withCapabilityLinks,
    withRunLinks,
    env: processEnv
  });

  const runDraftHandlers = createRunDraftHandlers({
    createRunDraft,
    discardRunDraft,
    dispatchRun,
    evaluatePreflight,
    getCapability,
    getRunDraft,
    listApprovals,
    listRunDrafts,
    markRunDraftSubmitted,
    notifyTelegram,
    recordAudit,
    updateRunDraft,
    withRunLinks
  });

  const scheduleHandlers = createScheduleHandlers({
    addRunEvent,
    autoDisableSchedule,
    claimScheduleFire,
    createSchedule,
    deleteSchedule,
    dispatchRun,
    getCapability,
    getSchedule,
    listApprovals,
    listDueSchedules,
    listSchedules,
    notifyTelegram,
    recordAudit,
    recordScheduleFireResult,
    setScheduleEnabled,
    updateSchedule,
    withRunLinks
  });

  const workItemHandlers = createWorkItemHandlers({
    createWorkItem,
    deleteWorkItem,
    getRun,
    getWorkItem,
    linkRunToWorkItem,
    listApprovals,
    listArtifacts,
    listBoards,
    listWorkItemEvents,
    listWorkItemRuns,
    listWorkItems,
    recordAudit,
    syncWorkItemForRun,
    unlinkRunFromWorkItem,
    updateWorkItem,
    withRunLinks,
    workItemRunSummaries
  });

  const boardHandlers = createBoardHandlers({
    createBoard,
    getBoard,
    listBoards,
    listWorkItems,
    recordAudit,
    updateBoard,
    workItemRunSummaries
  });

  const boardDefinitionHandlers = createBoardDefinitionHandlers({
    createBoard,
    createSchedule,
    getBoard,
    getSchedule,
    listBoards,
    listSchedules,
    recordAudit,
    updateBoard,
    updateSchedule
  });

  const catalogHandlers = createCatalogHandlers({
    listAgents,
    listKnowledge,
    listSkills,
    upsertAgent,
    upsertKnowledge,
    upsertSkill,
    withAgentLinks
  });

  const approvalHandlers = createApprovalHandlers({
    answerTelegramCallbackQuery,
    clearTelegramApprovalButtons,
    updateTelegramApprovalMessage,
    createApproval,
    dispatchRunResponseEndpointDelivery,
    getApproval,
    getRun,
    listApprovals,
    notifyTelegram,
    resolveApproval,
    telegramApprovalTarget,
    telegramWebhookSecret: () => env.telegramWebhookSecret,
    timingSafeEqualStr,
    withApprovalLinks
  });

  const artifactHandlers = createArtifactHandlers({
    artifactDir: env.artifactDir,
    getArtifact,
    getRun,
    listArtifacts,
    storeRunArtifact,
    withArtifactLinks
  });

  const supportChatHandlers = createSupportChatHandlers({
    buildSupportLiveContext,
    chatWithSupportAgent,
    recordAudit,
    supportAgentInfo
  });

  const hookProfileHandlers = createHookProfileHandlers({
    getCapability,
    getHookProfile,
    listHookProfiles,
    recordAudit,
    secretExists,
    secretsEnabled,
    upsertHookProfile
  });

  const secretHandlers = createSecretHandlers({
    deleteSecret,
    listSecretMeta,
    recordAudit,
    secretExists,
    secretsEnabled,
    upsertSecret
  });

  const tokenHandlers = createTokenHandlers({
    createAccessToken,
    listAccessTokens,
    recordAudit,
    revokeAccessToken
  });

  const updateHandlers = createUpdateHandlers({
    env,
    getUpdateChecker,
    getVersionInfo,
    latestAlert,
    recordAlert,
    recordAudit
  });

  const adminReadHandlers = createAdminReadHandlers({
    listAlerts,
    listAudit
  });

  const {
    authFromRequest,
    requireAuth,
    requireRunOwnerOrAdmin,
    requireScopes
  } = createAuthMiddleware({
    authenticateTelegramWebAppSession,
    authenticateToken,
    env,
    getRun,
    runOwnerTokenId,
    telegramSessionCanAccess
  });

  const authHandlers = createAuthHandlers({
    authFromRequest,
    authenticateToken,
    baseUrl: env.baseUrl,
    createTelegramWebAppSession,
    env,
    recordAudit,
    telegramApprovalTarget,
    telegramUserLabel,
    timingSafeEqualStr,
    verifyTelegramWebAppInitData
  });

  const publicHandlers = createPublicHandlers({
    authFromRequest,
    dashboardStats,
    env,
    getVersionInfo,
    listCapabilities,
    runnerPoolStats,
    startedAt,
    withCapabilityLinks
  });

  // --- CI platform (GitHub bridge + pipelines; specs/ci-platform.md) -------
  const githubApp = createGitHubApp({ env });

  const ciTriggers = createCiTriggers({
    env,
    githubApp,
    getScmRepo,
    getCapability,
    createRun,
    transitionRun,
    addRunEvent,
    recordAudit,
    createCiPipeline,
    setCiPipelineRun,
    listCiJobs,
    markCiJobPhase,
    getCiJob,
    getCiPipeline,
    listActiveCiPipelines,
    markCiPipelineSuperseded,
    getRun
  });

  const ciOrchestrator = createCiOrchestrator({
    env,
    getCiPipeline,
    listCiJobs,
    listActiveCiPipelines,
    markCiJobDispatched,
    markCiJobPhase,
    findCiJobRunCandidate,
    lastCiRunEventAt,
    getCiJobByRunId,
    getScmRepo,
    getCapability,
    createRun,
    transitionRun,
    addRunEvent,
    getRun,
    pruneScmWebhookDeliveries
  });

  const ciReporter = createCiReporter({
    env,
    githubApp,
    listRecentCiPipelines,
    listCiJobs,
    getScmRepo,
    getRun,
    updateCiJobCheck,
    updateCiPipelineCheck
  });

  // CI fast path: job/pipeline run status changes advance the DAG at once;
  // the 60s maintenance sweep remains the restart/recovery backstop.
  if (typeof setCiRunStatusObserver === "function") {
    setCiRunStatusObserver((updatedRun) => ciOrchestrator.handleRunStatusChange(updatedRun));
  }

  // Debounced check sync so a burst of webhook/job activity coalesces into
  // one Checks API reconciliation pass shortly after.
  let checkSyncTimer = null;
  function syncChecksSoon() {
    if (checkSyncTimer) return;
    checkSyncTimer = setTimeout(() => {
      checkSyncTimer = null;
      ciReporter.sync().catch((error) => console.error("CI check sync failed:", error.message));
    }, 2_000);
    checkSyncTimer.unref?.();
  }

  const ciWebhookHandlers = createGithubWebhookHandlers({
    env,
    githubApp,
    ciTriggers,
    advancePipeline: (pipelineId) => ciOrchestrator.advancePipeline(pipelineId),
    syncChecksSoon,
    findScmWebhookDelivery,
    recordScmWebhookDelivery,
    upsertScmInstallation,
    upsertScmRepo,
    getScmRepo,
    setScmRepoEnabled,
    recordAudit
  });

  const ciHandlers = createCiHandlers({
    env,
    githubApp,
    ciTriggers,
    ciOrchestrator,
    ciReporter,
    webhookCounters: ciWebhookHandlers.counters,
    getScmRepo,
    listScmRepos,
    listScmInstallations,
    upsertScmInstallation,
    upsertScmRepo,
    setScmRepoEnabled,
    setScmRepoTrustPolicy,
    listScmWebhookDeliveries,
    countScmWebhookDeliveries,
    listCiPipelines,
    getCiPipeline,
    getCiPipelineByRunId,
    listCiJobs,
    getCiJobByRunId,
    getRun,
    transitionRun,
    addRunEvent,
    recordAudit,
    withRunLinks
  });

  // One maintenance tick for the CI platform: advance active pipelines, then
  // reconcile GitHub checks. Called from startRunMaintenance every 60s.
  function ciMaintenanceTick() {
    ciOrchestrator.sweep();
    ciReporter.sync().catch((error) => console.error("CI check sync failed:", error.message));
  }

  const operatorReadHandlers = createOperatorReadHandlers({
    dashboardStats,
    env: processEnv,
    listApprovals,
    listRuns,
    runnerPoolStats,
    withApprovalLinks,
    withRunLinks
  });

  return {
    ciMaintenanceTick,
    fireDueSchedules: (nowIso) => scheduleHandlers.fireDueSchedules(nowIso),
    notifyTelegram,
    pruneDeadRunners,
    reapStuckRunsWithRetrospectives,
    reconcileRunnerActiveRuns,
    sweepSupersededApprovals,
    sweepTimedApprovals: sweepTimedApprovalsAndUpdateTelegram,
    routes: {
      adminReadHandlers,
      approvalHandlers,
      artifactHandlers,
      authHandlers,
      ciHandlers,
      ciWebhookHandlers,
      capabilityHandlers,
      catalogHandlers,
      gatewayHandlers,
      hookProfileHandlers,
      operatorReadHandlers,
      publicHandlers,
      requireAuth,
      requireRunOwnerOrAdmin,
      requireScopes,
      runDraftHandlers,
      runLifecycleHandlers,
      runPromotionHandlers,
      runReadHandlers,
      runRerunHandlers,
      scheduleHandlers,
      secretHandlers,
      supportChatHandlers,
      tokenHandlers,
      updateHandlers,
      workflowBundleHandlers,
      workflowPackageHandlers,
      workflowEndpointHandlers,
      workItemHandlers,
      boardHandlers,
      boardDefinitionHandlers
    },
    telegramApprovalTarget
  };
}
