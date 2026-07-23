import { execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { allowlistedBaseEnv } from "./childEnv.js";
import { RUN_FAILURE_CLASSES } from "./runFailureClass.js";

// Deterministic CI job executor for the RunYard runner (specs/ci-platform.md).
// Handles runs whose capability engine is "runyard-ci": SHA-pinned checkout
// (with deterministic merge-candidate construction for PRs), then the native
// command adapter or the Dagger adapter — no Smithers engine, no LLM.
//
// Security posture:
// - the workspace lives under an isolated per-run directory with path
//   containment on every configured sub-path and artifact glob;
// - git credentials are minted just in time from the hub (never part of the
//   claim payload), passed to git via environment config — never argv, never
//   the job's own environment;
// - the child env is the strict allowlist baseline + validated non-secret
//   config env + hub-delivered secretEnv; native execution requires BOTH the
//   repo trust policy (hub-compiled) and this runner's explicit opt-in.

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const CANCEL_POLL_MS = 5_000;
const LOG_FLUSH_BYTES = 8 * 1024;
const LOG_FLUSH_MS = 2_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 50;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 24 * 1024 * 1024;
// Deterministic timestamps make the constructed merge commit reproducible for
// identical (base, head) pairs; the tested TREE is the real provenance.
const MERGE_EPOCH = "1750000000 +0000";

export function runnerCiConfigFromEnv(env = process.env) {
  return {
    enabled: env.RUNYARD_RUNNER_CI === "1" || env.RUNYARD_RUNNER_CI === "true",
    nativeAllowed: env.RUNYARD_RUNNER_CI_NATIVE === "1" || env.RUNYARD_RUNNER_CI_NATIVE === "true",
    workDir: env.RUNYARD_RUNNER_CI_DIR || "",
    retainFailedMs: Number(env.RUNYARD_RUNNER_CI_RETAIN_MS || 24 * 60 * 60_000)
  };
}

export function isCiAssignment(capability, run) {
  return capability?.workflow?.engine === "runyard-ci" || run?.input?.__ci?.role === "job";
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
// https-only, no userinfo, no leading dash anywhere an argv could see.
const CLONE_URL_PATTERN = /^https:\/\/[a-zA-Z0-9][\w.-]*(?::\d+)?\/[\w.-]+\/[\w.-]+(?:\.git)?$/;
// Test seam only (never env-configurable): offline fixtures use local repos.
const FILE_CLONE_URL_PATTERN = /^file:\/\/\/[\w./-]+$/;

export function validateCiCheckoutInput(ci, { allowFileCloneUrls = false } = {}) {
  if (!ci || typeof ci !== "object") return "run carries no __ci payload";
  const cloneUrlOk = CLONE_URL_PATTERN.test(ci.repo?.cloneUrl || "") ||
    (allowFileCloneUrls && FILE_CLONE_URL_PATTERN.test(ci.repo?.cloneUrl || ""));
  if (!cloneUrlOk) {
    return `unsafe or missing clone url`;
  }
  const checkout = ci.checkout || {};
  if (!SHA_PATTERN.test(checkout.headSha || "")) return "checkout.headSha must be a full commit sha";
  if (checkout.strategy === "merge" && !SHA_PATTERN.test(checkout.baseSha || "")) {
    return "merge checkout requires a full base sha";
  }
  if (!["merge", "head"].includes(checkout.strategy || "")) return `unknown checkout strategy '${checkout.strategy}'`;
  return "";
}

export function containedPath(root, relative) {
  const resolved = path.resolve(root, relative || ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the job workspace: ${relative}`);
  }
  return resolved;
}

// Expand validated artifact globs (ciConfig syntax: *, **, ?) inside the
// workspace. Symlinks are skipped entirely — a link pointing outside the
// workspace must never be readable through an artifact.
export function expandArtifactGlobs(root, globs = []) {
  if (!globs.length) return [];
  const regexes = globs.map((glob) => globToArtifactRegExp(glob));
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_ARTIFACT_FILES) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (regexes.some((regex) => regex.test(relative))) found.push({ absolute, relative });
    }
  };
  walk(root);
  return found;
}

function globToArtifactRegExp(pattern) {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`);
}

// Sweep leftover job workspaces beyond the retention window (bounded
// evidence for failed jobs; successful ones are removed immediately).
export function sweepCiWorkspaces(baseDir, retainMs, nowMs = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(baseDir, entry.name);
    try {
      if (nowMs - statSync(absolute).mtimeMs > retainMs) {
        rmSync(absolute, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Never let janitorial work break the runner.
    }
  }
  return removed;
}

// Git credential via environment config only. `basic` auth with the GitHub
// installation token as password; the header never appears in argv or logs.
function gitEnv(baseEnv, token) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = header;
  }
  return env;
}

export function createRunnerCi({
  workspace,
  runnerName,
  runnerId,
  client,
  event,
  failRun,
  config = runnerCiConfigFromEnv(),
  baseEnv = process.env,
  execFileImpl = execFileAsync,
  spawnImpl = spawn,
  nowMs = () => Date.now(),
  log = console.log,
  logError = console.error
} = {}) {
  const ciBaseDir = path.resolve(config.workDir || path.join(workspace, ".runyard-ci"));
  // runner.js learns its hub-assigned id after registration; accept either a
  // value or a getter so events always carry the current id.
  const currentRunnerId = () => (typeof runnerId === "function" ? runnerId() : runnerId);

  async function git(args, { cwd, env, timeout = GIT_TIMEOUT_MS } = {}) {
    return execFileImpl("git", args, { cwd, env, timeout, maxBuffer: 1024 * 1024 * 8 });
  }

  async function probeDagger() {
    try {
      const { stdout } = await execFileImpl("dagger", ["version"], { timeout: 15_000, env: allowlistedBaseEnv(baseEnv) });
      return { available: true, version: String(stdout || "").trim() };
    } catch (error) {
      return { available: false, error: error.code === "ENOENT" ? "dagger binary not found on this runner" : String(error.message || error) };
    }
  }

  // JIT read-only git credential from the hub. Absent hub support / public
  // repos degrade to anonymous fetch.
  async function mintGitCredential(runId) {
    try {
      const response = await client.post(`/api/ci/runs/${runId}/git-credential`, {});
      return response?.token || "";
    } catch (error) {
      log(`git credential mint unavailable for ${runId} (anonymous fetch): ${error.message}`);
      return "";
    }
  }

  async function observedRunStatus(runId) {
    try {
      const detail = await client.get(`/api/runs/${runId}`);
      return detail?.run?.status || "";
    } catch {
      return "";
    }
  }

  async function checkout({ run, ci, workDir, token }) {
    const cleanEnv = allowlistedBaseEnv(baseEnv);
    const env = gitEnv(cleanEnv, token);
    const { checkout: co, repo } = ci;
    await git(["init", "--quiet"], { cwd: workDir, env });
    await git(["remote", "add", "origin", repo.cloneUrl], { cwd: workDir, env });
    const wanted = co.strategy === "merge" ? [co.baseSha, co.headSha] : [co.headSha];
    await git(["fetch", "--quiet", "--no-tags", "origin", ...wanted], { cwd: workDir, env, timeout: 10 * 60_000 });

    if (co.strategy === "head") {
      await git(["checkout", "--quiet", "--detach", co.headSha], { cwd: workDir, env });
      const { stdout } = await git(["rev-parse", "HEAD^{tree}"], { cwd: workDir, env });
      return { testedSha: co.headSha, treeSha: stdout.trim(), strategy: "head" };
    }

    // Deterministic merge candidate: merge the pinned head INTO the pinned
    // base. Every job of the pipeline builds the identical tree; a conflict
    // is a first-class blocked conclusion (never a silent head-only test).
    await git(["checkout", "--quiet", "--detach", co.baseSha], { cwd: workDir, env });
    const mergeEnv = {
      ...env,
      GIT_AUTHOR_NAME: "runyard-ci",
      GIT_AUTHOR_EMAIL: "ci@runyard.invalid",
      GIT_COMMITTER_NAME: "runyard-ci",
      GIT_COMMITTER_EMAIL: "ci@runyard.invalid",
      GIT_AUTHOR_DATE: MERGE_EPOCH,
      GIT_COMMITTER_DATE: MERGE_EPOCH
    };
    try {
      await git(["merge", "--no-ff", "--no-edit", "-m", `runyard-ci merge candidate: ${co.headSha} into ${co.baseSha}`, co.headSha], {
        cwd: workDir,
        env: mergeEnv,
        timeout: 5 * 60_000
      });
    } catch (error) {
      const conflict = /conflict/i.test(`${error.stdout || ""}${error.stderr || ""}${error.message || ""}`);
      const detail = String(error.stderr || error.stdout || error.message || "merge failed").slice(0, 1500);
      const wrapped = new Error(conflict ? `merge candidate conflicted: ${detail}` : `merge candidate construction failed: ${detail}`);
      wrapped.ciMergeConflict = conflict;
      throw wrapped;
    }
    const { stdout: mergeSha } = await git(["rev-parse", "HEAD"], { cwd: workDir, env });
    const { stdout: treeSha } = await git(["rev-parse", "HEAD^{tree}"], { cwd: workDir, env });
    return { testedSha: mergeSha.trim(), treeSha: treeSha.trim(), strategy: "merge", baseSha: co.baseSha, headSha: co.headSha };
  }

  // Bounded log streaming: merged stdout+stderr, flushed as run events in
  // chunks; total output is capped with an explicit truncation notice.
  function createLogStream(runId, jobName) {
    let buffer = "";
    let streamedBytes = 0;
    let truncated = false;
    let full = "";
    let timer = null;
    const flush = async () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      await event(runId, "ci.job.log", chunk.slice(0, 3900), { "cicd.pipeline.task.name": jobName });
    };
    const push = (chunk) => {
      const text = chunk.toString("utf8");
      if (full.length < MAX_LOG_BYTES) full += text.slice(0, MAX_LOG_BYTES - full.length);
      if (truncated) return;
      streamedBytes += Buffer.byteLength(text);
      if (streamedBytes > MAX_LOG_BYTES) {
        truncated = true;
        buffer += "\n[log truncated: output exceeded the CI streaming cap]";
        flush().catch(() => {});
        return;
      }
      buffer += text;
      if (Buffer.byteLength(buffer) >= LOG_FLUSH_BYTES) {
        flush().catch(() => {});
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush().catch(() => {});
        }, LOG_FLUSH_MS);
        timer.unref?.();
      }
    };
    const finish = async () => {
      if (timer) clearTimeout(timer);
      await flush();
      return { full, truncated };
    };
    return { push, finish };
  }

  function killProcessGroup(child, signal) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  // Run one adapter process with timeout, hub-cancellation polling, and
  // process-group cleanup. Resolves { exitCode, cancelled, timedOut, log }.
  function runAdapterProcess({ runId, jobName, command, args, cwd, env, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const logs = createLogStream(runId, jobName);
      let settled = false;
      let timedOut = false;
      let cancelled = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
        setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000).unref?.();
      }, timeoutMs);
      timeout.unref?.();

      const cancelPoll = setInterval(async () => {
        const status = await observedRunStatus(runId);
        if (["cancelled", "paused"].includes(status) || (status && isTerminalStatus(status))) {
          cancelled = true;
          killProcessGroup(child, "SIGTERM");
          setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000).unref?.();
        }
      }, CANCEL_POLL_MS);
      cancelPoll.unref?.();

      child.stdout.on("data", logs.push);
      child.stderr.on("data", logs.push);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(cancelPoll);
        reject(error);
      });
      child.on("close", async (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(cancelPoll);
        const { full, truncated } = await logs.finish();
        resolve({ exitCode: code, signal, cancelled, timedOut, log: full, truncated });
      });
    });
  }

  function isTerminalStatus(status) {
    return ["succeeded", "cancelled", "failed", "blocked_by_gate", "blocked_by_preflight", "provider_limited", "timed_out", "invalid_output", "infra_unavailable", "needs_human", "budget_exceeded"].includes(status);
  }

  async function uploadArtifacts({ runId, workDir, spec, jobLog }) {
    const artifacts = [];
    let totalBytes = 0;
    const files = expandArtifactGlobs(workDir, spec.artifacts || []);
    for (const file of files) {
      try {
        const real = realpathSync(file.absolute);
        if (real !== workDir && !real.startsWith(workDir + path.sep)) continue;
        const size = statSync(real).size;
        if (size > MAX_ARTIFACT_BYTES || totalBytes + size > MAX_TOTAL_ARTIFACT_BYTES) continue;
        totalBytes += size;
        await client.post(`/api/runs/${runId}/artifacts`, {
          name: file.relative.split("/").join("__"),
          kind: "file",
          mimeType: "application/octet-stream",
          contentBase64: readFileSync(real).toString("base64"),
          metadata: { source: "ci-artifact-glob", path: file.relative }
        });
        artifacts.push(file.relative);
      } catch (error) {
        logError(`artifact upload failed for ${file.relative}:`, error.message);
      }
    }
    if (jobLog) {
      try {
        await client.post(`/api/runs/${runId}/artifacts`, {
          name: "ci-job-log.txt",
          kind: "log",
          mimeType: "text/plain",
          content: jobLog.slice(0, MAX_LOG_BYTES),
          metadata: { source: "ci-job-log" }
        });
      } catch (error) {
        logError("job log artifact upload failed:", error.message);
      }
    }
    return artifacts;
  }

  // Entry point from the runner's executeAssignment. Returns true when the
  // run was a CI job (handled here, success or failure).
  async function handleCiRun({ capability, run, secretEnv = {} }) {
    if (!isCiAssignment(capability, run)) return false;
    const ci = run.input?.__ci;

    const invalid = validateCiCheckoutInput(ci, { allowFileCloneUrls: Boolean(config.allowFileCloneUrls) });
    if (invalid) {
      await failCi(run.id, `CI preflight failed: ${invalid}`, RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
      return true;
    }
    if (!config.enabled) {
      await failCi(run.id, "this runner is not CI-enabled (set RUNYARD_RUNNER_CI=1)", RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
      return true;
    }
    const spec = ci.spec || {};
    if (ci.executor === "native" && !config.nativeAllowed) {
      await failCi(run.id, "native CI execution is disabled on this runner (RUNYARD_RUNNER_CI_NATIVE)", RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
      return true;
    }
    let dagger = null;
    if (ci.executor === "dagger") {
      dagger = await probeDagger();
      if (!dagger.available) {
        await failCi(
          run.id,
          `Dagger is not available on this runner: ${dagger.error}. Install the open-source Dagger engine (docs/guides/ci) or switch the job to the native executor.`,
          RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE
        );
        return true;
      }
    }

    mkdirSync(ciBaseDir, { recursive: true });
    sweepCiWorkspaces(ciBaseDir, config.retainFailedMs, nowMs());
    const workDir = containedPath(ciBaseDir, String(run.id).replace(/[^a-zA-Z0-9_-]/g, "_"));
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });

    let succeeded = false;
    try {
      await event(run.id, "ci.job.started", `CI job ${ci.jobName} (${ci.executor}) on ${runnerName}`, {
        runnerId: currentRunnerId(),
        "cicd.pipeline.name": ci.pipelineName,
        "cicd.pipeline.run.id": ci.pipelineId,
        "cicd.pipeline.task.name": ci.jobName,
        "cicd.worker.id": currentRunnerId(),
        executor: ci.executor,
        ...(dagger ? { daggerVersion: dagger.version } : {})
      });

      // Checkout (JIT credential; provenance recorded before execution).
      const token = await mintGitCredential(run.id);
      let tested;
      try {
        tested = await checkout({ run, ci, workDir, token });
      } catch (error) {
        const conflict = Boolean(error.ciMergeConflict);
        await failCi(
          run.id,
          conflict
            ? `merge candidate unavailable: ${error.message}. The PR must be updated/rebased before CI can test the integration result.`
            : `checkout failed: ${error.message}`,
          conflict ? RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT : RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE
        );
        return true;
      }
      await event(run.id, "ci.job.checkout", `Checked out ${tested.strategy} ${tested.testedSha}`, {
        strategy: tested.strategy,
        testedSha: tested.testedSha,
        treeSha: tested.treeSha,
        headSha: ci.checkout.headSha,
        ...(ci.checkout.baseSha ? { baseSha: ci.checkout.baseSha } : {})
      });

      const cwd = containedPath(workDir, spec.workingDir || ".");
      if (!existsSync(cwd)) {
        await failCi(run.id, `workingDir '${spec.workingDir}' does not exist in the checkout`, RUN_FAILURE_CLASSES.FAILED);
        return true;
      }
      // Job env: allowlisted baseline + validated non-secret config env +
      // hub-delivered secrets + CI context. The git credential is NOT here.
      const jobEnv = {
        ...allowlistedBaseEnv(baseEnv),
        ...(spec.env || {}),
        ...secretEnv,
        CI: "true",
        RUNYARD_CI: "1",
        RUNYARD_RUN_ID: run.id,
        RUNYARD_CI_PIPELINE: String(ci.pipelineId || ""),
        RUNYARD_CI_JOB: String(ci.jobName || ""),
        RUNYARD_CI_SHA: tested.testedSha,
        RUNYARD_CI_HEAD_SHA: ci.checkout.headSha,
        ...(ci.checkout.baseSha ? { RUNYARD_CI_BASE_SHA: ci.checkout.baseSha } : {})
      };
      const timeoutMs = Math.max(1000, Number(spec.timeoutMinutes || 30) * 60_000);

      let processResult;
      if (ci.executor === "native") {
        // Documented argv/shell contract: the command list joins into ONE
        // bash script running under `set -euo pipefail` — the first failing
        // command fails the job.
        const script = `set -euo pipefail\n${(spec.commands || []).join("\n")}`;
        processResult = await runAdapterProcess({
          runId: run.id,
          jobName: ci.jobName,
          command: "bash",
          args: ["-c", script],
          cwd,
          env: jobEnv,
          timeoutMs
        });
      } else {
        const daggerModule = containedPath(cwd, spec.dagger?.module || ".");
        const args = ["call", "-m", daggerModule, spec.dagger?.function || ""];
        for (const [key, value] of Object.entries(spec.dagger?.args || {})) {
          args.push(`--${key}`, String(value));
        }
        processResult = await runAdapterProcess({
          runId: run.id,
          jobName: ci.jobName,
          command: "dagger",
          args,
          cwd,
          env: jobEnv,
          timeoutMs
        });
      }

      const artifacts = await uploadArtifacts({ runId: run.id, workDir, spec, jobLog: processResult.log });

      if (processResult.cancelled) {
        // The hub already holds the terminal/paused state; nothing to report.
        await event(run.id, "runner.hub_terminal_observed", "Hub ended this CI job; process group cancelled.", {
          "cicd.pipeline.task.name": ci.jobName
        });
        return true;
      }
      if (processResult.timedOut) {
        await failCi(run.id, `CI job exceeded its ${Math.round(timeoutMs / 60_000)} minute timeout`, RUN_FAILURE_CLASSES.TIMED_OUT);
        return true;
      }
      if (processResult.exitCode === 0) {
        succeeded = true;
        await client.post(`/api/runs/${run.id}/complete`, {
          output: {
            conclusion: "succeeded",
            exitCode: 0,
            executor: ci.executor,
            tested,
            artifacts,
            "cicd.pipeline.result": "success"
          }
        });
        log(`CI job ${ci.jobName} (${run.id}) succeeded`);
        return true;
      }
      const tail = processResult.log.slice(-1500);
      await failCi(
        run.id,
        `CI job failed with exit code ${processResult.exitCode}${processResult.signal ? ` (signal ${processResult.signal})` : ""}\n${tail}`,
        RUN_FAILURE_CLASSES.FAILED
      );
      return true;
    } catch (error) {
      await failCi(run.id, `CI executor error: ${error.message}`, RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE).catch(() => {});
      return true;
    } finally {
      if (succeeded) {
        rmSync(workDir, { recursive: true, force: true });
      } else {
        // Keep failed workspaces (bounded by the retention sweep) as
        // actionable evidence for operators.
        try {
          writeFileSync(path.join(workDir, ".runyard-ci-failed"), `${new Date(nowMs()).toISOString()}\n`);
        } catch {
          // workspace may not exist if checkout never started
        }
      }
    }
  }

  async function failCi(runId, message, failureClass) {
    await event(runId, "ci.job.failed", message.slice(0, 3900), { failureClass });
    await failRun(runId, message, failureClass);
  }

  return { handleCiRun, probeDagger, ciBaseDir };
}
