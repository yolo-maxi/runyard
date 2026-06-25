import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function defaultImproveRepo(env = process.env, cwd = process.cwd()) {
  return env.IMPROVE_REPO_DIR || env.GATED_REPO_DIR || cwd;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function parseJsonObject(raw, envName) {
  const value = cleanString(raw);
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${envName} must be a JSON object mapping friendly repo names to absolute paths.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object mapping friendly repo names to absolute paths.`);
  }
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, repoPath]) => [cleanString(key), cleanString(repoPath)])
      .filter(([key, repoPath]) => key && repoPath)
  );
}

function parsePathList(raw, envName) {
  const value = cleanString(raw);
  if (!value) return [];
  if (value.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${envName} must be a JSON array or a comma-separated list of absolute paths.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${envName} must be a JSON array or a comma-separated list of absolute paths.`);
    }
    return parsed.map(cleanString).filter(Boolean);
  }
  return value.split(/[,\n]/).map(cleanString).filter(Boolean);
}

function canonicalPath(repoPath, label) {
  const resolved = path.resolve(repoPath);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  return realpathSync(resolved);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAbsolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute runner-local path: ${value}`);
}

function resolveGitTopLevel(repoPath, gitBin, gitEnv) {
  let stdout = "";
  try {
    stdout = execFileSync(gitBin, ["rev-parse", "--show-toplevel"], {
      cwd: repoPath,
      encoding: "utf8",
      env: gitEnv
    }).trim();
  } catch (error) {
    throw new Error(`improve target must be a git repository: ${repoPath}`);
  }
  return canonicalPath(stdout, "improve git repository root");
}

export function improveRepoMap(env = process.env) {
  return {
    ...parseJsonObject(env.IMPROVE_PROJECT_MAP, "IMPROVE_PROJECT_MAP"),
    ...parseJsonObject(env.IMPROVE_REPO_MAP, "IMPROVE_REPO_MAP")
  };
}

export function improveAllowedRoots(env = process.env, cwd = process.cwd()) {
  const defaultRoot = canonicalPath(defaultImproveRepo(env, cwd), "default improve repo");
  const extraRoots = parsePathList(env.IMPROVE_ALLOWED_REPO_ROOTS, "IMPROVE_ALLOWED_REPO_ROOTS").map((root) => {
    assertAbsolute(root, "IMPROVE_ALLOWED_REPO_ROOTS entry");
    return canonicalPath(root, "IMPROVE_ALLOWED_REPO_ROOTS entry");
  });
  return Array.from(new Set([defaultRoot, ...extraRoots]));
}

export function resolveImproveRepo(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const gitBin = options.gitBin || "git";
  const gitEnv = options.gitEnv || process.env;
  const repoDirInput = cleanString(input.repoDir);
  const repoKey = cleanString(input.repo);
  const projectKey = cleanString(input.project);
  const friendlyKey = repoKey || projectKey;

  if (repoKey && projectKey && repoKey !== projectKey) {
    throw new Error("improve accepts only one friendly repo selector; provide repo or project, not both.");
  }
  if (repoDirInput && friendlyKey) {
    throw new Error("improve accepts either repoDir or repo/project, not both.");
  }

  const defaultRepo = defaultImproveRepo(env, cwd);
  let selected = defaultRepo;
  let selectedLabel = "default improve repo";

  if (repoDirInput) {
    assertAbsolute(repoDirInput, "repoDir");
    selected = repoDirInput;
    selectedLabel = "repoDir";
  } else if (friendlyKey) {
    const repoMap = improveRepoMap(env);
    // "runyard" is the canonical default-repo key; "smithers-hub" stays a
    // back-compat alias so older configs/clients keep resolving to the default.
    const isDefaultKey = friendlyKey === "runyard" || friendlyKey === "smithers-hub";
    const mapped = repoMap[friendlyKey] || (isDefaultKey ? defaultRepo : "");
    if (!mapped) {
      throw new Error(`improve repo selector "${friendlyKey}" is not configured in IMPROVE_REPO_MAP or IMPROVE_PROJECT_MAP.`);
    }
    assertAbsolute(mapped, `improve repo selector "${friendlyKey}"`);
    selected = mapped;
    selectedLabel = `improve repo selector "${friendlyKey}"`;
  }

  const allowedRoots = improveAllowedRoots(env, cwd);
  const selectedPath = canonicalPath(selected, selectedLabel);
  if (!allowedRoots.some((root) => isInside(root, selectedPath))) {
    throw new Error(
      `improve repo path is outside allowed roots: ${selectedPath}. ` +
        `Allowed roots: ${allowedRoots.join(", ")}. Set IMPROVE_ALLOWED_REPO_ROOTS on the runner to permit more repos.`
    );
  }

  const repoPath = resolveGitTopLevel(selectedPath, gitBin, gitEnv);
  if (!allowedRoots.some((root) => isInside(root, repoPath))) {
    throw new Error(
      `improve git repository root is outside allowed roots: ${repoPath}. ` +
        `Allowed roots: ${allowedRoots.join(", ")}. Set IMPROVE_ALLOWED_REPO_ROOTS on the runner to permit more repos.`
    );
  }
  return repoPath;
}
