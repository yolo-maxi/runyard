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
    sweepTimedApprovals
  } = db;

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
    hiddenRunSlugs: DEFAULT_HIDDEN_RUN_SLUGS,
    listArtifacts,
    listRunEvents,
    listRunResponseEndpointsForRun,
    listRuns,
    presentRunResponseEndpoint,
    reapStuckRunsWithRetrospectives,
    runApprovalHold,
    runDeadlineMs: () => env.runDeadlineMs,
    runDiagnostics,
    runnerPoolStats,
    runTimelineEnabled: () => env.runTimelineEnabled,
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
    getWorkflowBundle,
    publishWorkflowBundle,
    listApprovals,
    listCapabilities,
    listCapabilityVersionsFromRuns,
    listHookProfiles,
    notifyTelegram,
    recordAudit,
    root: env.root,
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
      workflowEndpointHandlers
    },
    telegramApprovalTarget
  };
}
