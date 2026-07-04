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
import { createHubRepairDispatcher, createRunDispatcher } from "./runDispatch.js";
import { createSecretHandlers } from "./secretsRoutes.js";
import { createTokenHandlers } from "./tokenRoutes.js";
import { maybeRecordFailureClassAlert as maybeRecordFailureAlert } from "./failureAlerts.js";
import { createWorkflowEndpointHandlers } from "./workflowEndpointRoutes.js";
import { createHookProfileHandlers } from "./hookProfileRoutes.js";
import { createWorkflowBundleHandlers } from "./workflowBundleRoutes.js";
import { createRunLifecycleHandlers } from "./runLifecycleRoutes.js";
import { createRunReadHandlers } from "./runReadRoutes.js";
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
    countWorkflowEndpointInvocations,
    dashboardStats,
    findActiveSupervisorByToken,
    findRecentWorkflowEndpointInvocation,
    getArtifact,
    getApproval,
    getCapability,
    getWorkflowBundle,
    getWorkflowEndpoint,
    countRuns,
    createRunResponseEndpoint,
    createSchedule,
    listSchedules,
    getSchedule,
    updateSchedule,
    setScheduleEnabled,
    deleteSchedule,
    listDueSchedules,
    claimScheduleFire,
    recordScheduleFireResult,
    getRun,
    getHookProfile,
    listHookProfiles,
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
    listRunLineage,
    listRuns,
    listSkills,
    listWorkflowBundles,
    listWorkflowEndpoints,
    pruneDeadRunners,
    publishWorkflowBundle,
    reapStuckRunIds,
    reconcileFailedRecoverable,
    reconcileRepairChildTerminal,
    reconcileSupervisedChildTerminals,
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
    listSecretMeta,
    secretExists,
    upsertSecret,
    deleteSecret,
    secretsEnabled,
    scrubStoredSecrets,
    recordAlert,
    listAlerts,
    latestAlert,
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
    addRunEvent,
    createRun,
    findActiveSupervisorByToken,
    getCapability
  });

  const dispatchHubRepair = createHubRepairDispatcher({
    addRunEvent,
    createRun,
    getCapability
  });

  const {
    answerTelegramCallbackQuery,
    clearTelegramApprovalButtons,
    notifyTelegram,
    telegramApprovalTarget
  } = createTelegramApprovalNotifier({
    approvalContext,
    env,
    getCapability,
    getRun
  });

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

  const runLifecycleHandlers = createRunLifecycleHandlers({
    addRunEvent,
    createRun,
    getCapability,
    maybeRecordFailureClassAlert,
    recordRunTerminalArtifacts,
    resolveEngineApprovalOnResume,
    scrubStoredSecrets,
    transitionRun,
    updateRun,
    withRunLinks
  });

  const runReadHandlers = createRunReadHandlers({
    countRuns,
    decorateSingleRun,
    getRun,
    hiddenRunSlugs: DEFAULT_HIDDEN_RUN_SLUGS,
    listArtifacts,
    listRunEvents,
    listRunLineage,
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
    createRunResponseEndpoint,
    dispatchRun,
    getCapability,
    getWorkflowBundle,
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
    dispatchHubRepair,
    fireDueSchedules: (nowIso) => scheduleHandlers.fireDueSchedules(nowIso),
    notifyTelegram,
    pruneDeadRunners,
    reapStuckRunsWithRetrospectives,
    reconcileFailedRecoverable,
    reconcileSupervisedChildTerminals,
    reconcileRunnerActiveRuns,
    sweepSupersededApprovals,
    sweepTimedApprovals,
    routes: {
      adminReadHandlers,
      approvalHandlers,
      artifactHandlers,
      authHandlers,
      capabilityHandlers,
      catalogHandlers,
      hookProfileHandlers,
      operatorReadHandlers,
      publicHandlers,
      requireAuth,
      requireRunOwnerOrAdmin,
      requireScopes,
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
      workflowEndpointHandlers
    },
    telegramApprovalTarget
  };
}
