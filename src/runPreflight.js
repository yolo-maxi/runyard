// Deterministic run-creation preflight (negotiation).
//
// Turns rough caller input into a proposed typed run spec and evaluates —
// before anything is enqueued — the same conditions that would otherwise
// surface as a runner-side `blocked_by_preflight` failure or a doomed queue
// entry. Every check is deterministic (schema fields, catalog/config lookups,
// registered-runner tags); no agent, no supervisor, no network calls.
//
// The result is the negotiation contract shared by:
//   POST /api/workflows/:id/preflight        (stateless report)
//   POST /api/workflows/:id/run  {negotiate}  (enqueue only when ready)
//   /api/run-drafts                               (create → patch → submit)
//
//   status     ready | needs_input | blocked
//   input      normalized proposed input (title trimmed/normalized)
//   execution  normalized execution intent (mode / runnerLocation)
//   questions  what the caller must still provide (needs_input)
//   blockers   operator/config problems the caller cannot patch around
//   warnings   advisory only — never prevent submission
//   checks     the full deterministic checklist that produced the above
//   nextAction one human/agent-readable instruction

import {
  executionIntentMatchesRunnerTags,
  normalizeExecutionIntent,
  normalizeExecutionMode
} from "./runExecution.js";
import { resolveHarnessSelection } from "./runHarnessSelection.js";
import { gatewayMeteringIssues } from "./meteringGateway.js";
import { normalizeRunBudget, requestedRunBudget } from "./runBudget.js";
import { secretNamesForRun } from "./runnerAssignment.js";
import { eligibleHookProfiles } from "./hookProfileRecords.js";
import { buildRepoCatalog } from "./repoCatalog.js";
import {
  loadWorkflowSource,
  workflowBundleReference,
  workflowBundleSizeError
} from "./workflowSource.js";

export const RUN_PREFLIGHT_READY = "ready";
export const RUN_PREFLIGHT_NEEDS_INPUT = "needs_input";
export const RUN_PREFLIGHT_BLOCKED = "blocked";

export const RUN_PREFLIGHT_STATUSES = Object.freeze([
  RUN_PREFLIGHT_READY,
  RUN_PREFLIGHT_NEEDS_INPUT,
  RUN_PREFLIGHT_BLOCKED
]);

const MAX_TITLE_LENGTH = 140;

// Collapse whitespace/control characters and cap length. Returns "" when the
// value has no usable text, so callers can treat "   " like a missing title.
export function normalizeRunTitle(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

// Deterministic advisory title: "<Workflow name>: <first schema'd string
// input value>" when one exists, else "<Workflow name> run". Never random,
// never model-generated — the caller can accept or replace it.
export function suggestRunTitle(capability, input = {}) {
  const name = capability?.name || capability?.slug || "Run";
  const properties = capability?.inputSchema?.properties;
  if (properties && typeof properties === "object") {
    for (const field of Object.keys(properties)) {
      if (field === "title") continue;
      const value = input?.[field];
      if (typeof value !== "string") continue;
      const text = normalizeRunTitle(value).slice(0, 80);
      if (text) return normalizeRunTitle(`${name}: ${text}`);
    }
  }
  return `${name} run`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesSchemaType(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    default: return true;
  }
}

function missingValue(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export function evaluateRunPreflight({ capability, input, options = {}, context = {} } = {}) {
  const checks = [];
  const questions = [];
  const blockers = [];
  const warnings = [];
  const suggestedDefaults = {};

  const check = (id, status, detail) => checks.push({ id, status, detail });
  const blocker = (code, message, extra = {}) => {
    blockers.push({ code, message, ...extra });
    check(code, "fail", message);
  };
  const warning = (code, message) => {
    warnings.push({ code, message });
    check(code, "warn", message);
  };
  const question = (field, ask, expected, suggested) => {
    questions.push({ field, question: ask, expected, ...(suggested !== undefined ? { suggested } : {}) });
    check(`input_${field}`, "needs_input", ask);
  };

  // --- workflow ---------------------------------------------------------------
  if (!capability) {
    blocker("workflow_not_found", "workflow not found");
    return finalize({ capability: null, input: {}, options, checks, questions, blockers, warnings, suggestedDefaults });
  }
  if (!capability.enabled) {
    blocker("workflow_disabled", `workflow ${capability.slug} is disabled; an admin can re-enable it via PATCH /api/workflows/${capability.slug}`);
  } else {
    check("workflow_enabled", "pass", `workflow ${capability.slug} exists and is enabled`);
  }

  // --- input shape ------------------------------------------------------------
  let rawInput = input;
  if (rawInput !== undefined && rawInput !== null && !isPlainObject(rawInput)) {
    question("input", "input must be a JSON object", "object");
    rawInput = {};
  }
  const normalizedInput = isPlainObject(rawInput) ? { ...rawInput } : {};

  // --- required schema fields ---------------------------------------------------
  const schema = isPlainObject(capability.inputSchema) ? capability.inputSchema : {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  let requiredSatisfied = true;
  for (const field of required) {
    const property = isPlainObject(properties[field]) ? properties[field] : {};
    const value = normalizedInput[field];
    if (missingValue(value)) {
      requiredSatisfied = false;
      question(field, property.description || `Provide a value for "${field}".`, property.type || "value");
      continue;
    }
    if (property.type && !matchesSchemaType(value, property.type)) {
      requiredSatisfied = false;
      question(field, `"${field}" must be of type ${property.type}.`, property.type);
    }
  }
  if (required.length && requiredSatisfied) {
    check("required_fields", "pass", `required input fields present: ${required.join(", ")}`);
  }
  // Optional schema'd fields with the wrong primitive type are still questions:
  // the runner-side workflow would otherwise fail with invalid_output/zod noise.
  for (const [field, property] of Object.entries(properties)) {
    if (required.includes(field) || !isPlainObject(property) || !property.type) continue;
    const value = normalizedInput[field];
    if (value === undefined || value === null) continue;
    if (!matchesSchemaType(value, property.type)) {
      question(field, `"${field}" must be of type ${property.type}.`, property.type);
    }
  }

  // --- title recommendation/normalization --------------------------------------
  const title = normalizeRunTitle(normalizedInput.title);
  if (title) {
    normalizedInput.title = title;
    check("title", "pass", "input.title present");
  } else {
    delete normalizedInput.title;
    suggestedDefaults.title = suggestRunTitle(capability, normalizedInput);
    warning("title_missing", "input.title is recommended for agent-created runs: a short human-readable title for run lists, approval cards, and handoff. A deterministic suggestion is available in suggestedDefaults.title.");
  }

  // --- execution intent + runner availability -----------------------------------
  const execution = normalizeExecutionIntent(normalizedInput, options);
  const rawMode = options.executionMode ?? options.where ?? options.execution?.mode;
  if (rawMode !== undefined && rawMode !== null && String(rawMode).trim() !== "" && normalizeExecutionMode(rawMode) === "auto"
    && !["auto", "any", "default"].includes(String(rawMode).trim().toLowerCase())) {
    warning("execution_mode_unrecognized", `executionMode "${String(rawMode).trim()}" is not a known mode; treating it as auto. Known modes: local, remote, auto.`);
  }
  const runners = Array.isArray(context.runners) ? context.runners : null;
  if (runners) {
    const requiredTags = Array.isArray(capability.requiredRunnerTags) ? capability.requiredRunnerTags : [];
    const matching = runners.filter((runner) => {
      const tags = new Set(runner?.tags || []);
      if (!requiredTags.every((tag) => tags.has(tag))) return false;
      return executionIntentMatchesRunnerTags(execution, runner?.tags || []);
    });
    const wanted = [
      requiredTags.length ? `required tags: ${requiredTags.join(", ")}` : "required tags: (none)",
      execution.requested && execution.runnerLocation ? `location: ${execution.runnerLocation}` : ""
    ].filter(Boolean).join("; ");
    if (!matching.length) {
      blocker("no_matching_runner", `no registered runner matches this run (${wanted}); register a runner with those tags or change executionMode/runnerLocation`, {
        requiredRunnerTags: requiredTags,
        runnerLocation: execution.runnerLocation || ""
      });
    } else if (!matching.some((runner) => runner.online)) {
      warning("runners_offline", `runners matching this run (${wanted}) are registered but currently offline; the run would queue until one comes back`);
    } else {
      check("runner_available", "pass", `online runner available (${wanted})`);
    }
  }

  // --- harness selection (fail-closed config, mirrors runner preflight) ----------
  const harness = resolveHarnessSelection({ capability, input: normalizedInput });
  if (harness.issues.length) {
    for (const issue of harness.issues) blocker("harness_selection_invalid", issue);
  } else {
    check("harness_selection", "pass", "harness selection is valid");
  }

  // --- gateway metering (must be fully pinnable or the run must not launch) ------
  const meteringIssues = gatewayMeteringIssues(harness.selection);
  if (meteringIssues.length) {
    for (const issue of meteringIssues) blocker("metering_gateway_invalid", issue);
  } else if (harness.selection.metering === "gateway") {
    check("metering_gateway", "pass", "gateway metering selection is complete (pi harness, model, endpoint, named key)");
  }

  // --- budget ----------------------------------------------------------------------
  const { budget, issues: budgetIssues } = normalizeRunBudget(requestedRunBudget(normalizedInput, options));
  if (budgetIssues.length) {
    for (const issue of budgetIssues) blocker("budget_invalid", issue);
  } else if (budget) {
    check("budget", "pass", `run budget accepted (${Object.entries(budget).map(([key, value]) => `${key}=${value}`).join(", ")})`);
  }

  // --- secrets ------------------------------------------------------------------
  const secretNames = secretNamesForRun(capability, normalizedInput);
  if (secretNames.length) {
    if (!context.secretsEnabled) {
      blocker("secrets_unavailable", `this run needs Hub secrets (${secretNames.join(", ")}) but the secret store is not enabled on this Hub`, { secretNames });
    } else if (typeof context.secretExists === "function") {
      const missing = secretNames.filter((name) => !context.secretExists(name));
      if (missing.length) {
        blocker("missing_secret", `required secrets are not stored on the Hub: ${missing.join(", ")}; an admin can add them via PUT /api/secrets/{key}`, { secretNames: missing });
      } else {
        check("secrets", "pass", `required secrets stored: ${secretNames.join(", ")}`);
      }
    }
  }

  // --- repo / repoDir (mutating workflows) ----------------------------------------
  if (normalizedInput.repoDir !== undefined && normalizedInput.repoDir !== null) {
    const repoDir = String(normalizedInput.repoDir);
    if (typeof normalizedInput.repoDir !== "string" || !repoDir.trim() || !repoDir.startsWith("/")) {
      blocker("repo_dir_invalid", "input.repoDir must be an absolute runner-local path inside the runner's allowlisted improve roots; prefer a configured repo/project selector");
    } else {
      warning("repo_dir_manual", "input.repoDir is the advanced escape hatch: it must be runner-local and inside the runner's allowlisted improve roots. Prefer a configured repo/project selector from /api/repo-options.");
    }
  }
  const repoOptions = Array.isArray(context.repoOptions) ? context.repoOptions : null;
  if (repoOptions) {
    for (const selector of ["repo", "project"]) {
      const value = normalizedInput[selector];
      if (value === undefined || value === null || String(value).trim() === "") continue;
      const known = repoOptions.some((option) => option.selector === selector && option.value === String(value).trim());
      if (!known) {
        warning(`${selector}_unknown`, `input.${selector} "${String(value).trim()}" is not in the configured repo catalog (/api/repo-options); the runner will reject it unless it is allowlisted there`);
      }
    }
  }

  // --- post-run hooks (config-gated side effects, never core run failures) -------
  const requestedHooks = Array.isArray(normalizedInput.postRunHooks)
    ? normalizedInput.postRunHooks.map((slug) => String(slug || "").trim()).filter(Boolean)
    : [];
  if (requestedHooks.length) {
    const profiles = Array.isArray(context.hookProfiles) ? context.hookProfiles : [];
    const eligible = eligibleHookProfiles({ capability, profiles });
    const eligibleSlugs = new Set(eligible.map((profile) => profile.slug));
    const blockedHooks = requestedHooks.filter((slug) => !eligibleSlugs.has(slug));
    if (blockedHooks.length) {
      blocker("hook_blocked", `requested post-run hook profiles are not enabled/allowed for this workflow: ${blockedHooks.join(", ")}. An admin manages hook profiles via /api/hooks.`, {
        blocked: blockedHooks,
        eligible: [...eligibleSlugs]
      });
    } else {
      check("hooks", "pass", `post-run hooks eligible: ${requestedHooks.join(", ")}`);
    }
  }

  // --- workflow source (entry / bundle) -------------------------------------------
  const bundleId = workflowBundleReference(capability);
  const entry = String(capability.workflow?.entry || "").trim();
  if (!bundleId && !entry) {
    blocker("workflow_entry_missing", `workflow ${capability.slug} has no workflow.entry and no workflow.bundleId; the runner would fail preflight`);
  } else {
    let source = null;
    let bundleMissing = false;
    try {
      source = loadWorkflowSource(capability, {
        root: context.root || process.cwd(),
        getWorkflowBundle: context.getWorkflowBundle || null
      });
    } catch (cause) {
      if (cause.code !== "workflow_bundle_missing") throw cause;
      bundleMissing = true;
      blocker("workflow_bundle_missing", cause.message, { bundleId: cause.bundleId });
    }
    if (!bundleMissing) {
      const sizeError = source ? workflowBundleSizeError(source) : null;
      if (sizeError) {
        blocker("workflow_bundle_too_large", sizeError);
      } else if (source) {
        check("workflow_source", "pass", `workflow source resolved (${source.relativePath})`);
      } else {
        blocker("workflow_source_missing", `workflow.entry "${entry}" was not found under the Hub root; provide workflow source bytes or workflow.bundleId so the runner can execute DB-backed source`);
      }
    }
  }

  return finalize({ capability, input: normalizedInput, execution, options, checks, questions, blockers, warnings, suggestedDefaults });
}

function finalize({ capability, input, execution = null, checks, questions, blockers, warnings, suggestedDefaults }) {
  const status = blockers.length
    ? RUN_PREFLIGHT_BLOCKED
    : questions.length
      ? RUN_PREFLIGHT_NEEDS_INPUT
      : RUN_PREFLIGHT_READY;
  const nextAction = status === RUN_PREFLIGHT_READY
    ? "Preflight is green: enqueue via POST /api/workflows/{id}/run, or submit the draft via POST /api/run-drafts/{id}/submit."
    : status === RUN_PREFLIGHT_NEEDS_INPUT
      ? "Answer questions[] (PATCH the draft input, or amend the request input) and re-run preflight."
      : "Resolve blockers[] first — these are operator/config problems that more input cannot fix.";
  return {
    status,
    capability: capability?.slug || null,
    input,
    ...(execution ? { execution } : {}),
    questions,
    blockers,
    warnings,
    suggestedDefaults,
    checks,
    nextAction
  };
}

// Composition-side evaluator: binds the live Hub stores/config once so route
// handlers can preflight with just ({ capability, input, options }).
export function createRunPreflightEvaluator({
  listRunners,
  listHookProfiles = () => [],
  secretExists = null,
  secretsEnabled = () => false,
  getWorkflowBundle = null,
  root = process.cwd(),
  env = process.env
} = {}) {
  return function evaluatePreflight({ capability, input, options = {} }) {
    return evaluateRunPreflight({
      capability,
      input,
      options,
      context: {
        runners: typeof listRunners === "function" ? listRunners() : null,
        hookProfiles: listHookProfiles({ includeDisabled: false }),
        secretExists,
        secretsEnabled: Boolean(typeof secretsEnabled === "function" ? secretsEnabled() : secretsEnabled),
        getWorkflowBundle,
        root,
        repoOptions: buildRepoCatalog(env).options
      }
    });
  };
}
