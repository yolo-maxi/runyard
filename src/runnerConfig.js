import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function runnerConfigPath({ env = process.env, cwd = process.cwd() } = {}) {
  return (
    env.RUNYARD_RUNNER_CONFIG ||
    env.SMITHERS_RUNNER_CONFIG ||
    path.join(cwd, "runner.config.json")
  );
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function readJson(file, { exists = existsSync, readFile = readFileSync } = {}) {
  if (!file || !exists(file)) return {};
  try {
    const parsed = JSON.parse(readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, pathValue] of Object.entries(value)) {
    const cleanKey = cleanString(key);
    const cleanPath = cleanString(pathValue);
    if (cleanKey && cleanPath) out[cleanKey] = cleanPath;
  }
  return out;
}

function catalogRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const value = cleanString(row.value ?? row.key ?? row.repo ?? row.project);
      if (!value) return null;
      const label = cleanString(row.label ?? row.name) || value;
      const selector = cleanString(row.selector) === "project" || row.project ? "project" : "repo";
      const description = cleanString(row.description);
      return {
        value,
        label,
        selector,
        ...(description ? { description: description.slice(0, 200) } : {})
      };
    })
    .filter(Boolean);
}

export function runnerConfigEnv(config = {}) {
  const improve = config.improve && typeof config.improve === "object" ? config.improve : {};
  const env = {};
  const defaultRepo = cleanString(improve.defaultRepo ?? config.defaultRepo);
  const allowedRepoRoots = stringArray(improve.allowedRepoRoots ?? config.allowedRepoRoots);
  const repoMap = stringMap(improve.repoMap ?? config.repoMap);
  const projectMap = stringMap(improve.projectMap ?? config.projectMap);
  const repoCatalog = catalogRows(config.repoCatalog ?? improve.repoCatalog);

  if (defaultRepo) env.IMPROVE_REPO_DIR = defaultRepo;
  if (allowedRepoRoots.length) env.IMPROVE_ALLOWED_REPO_ROOTS = JSON.stringify(allowedRepoRoots);
  if (Object.keys(repoMap).length) env.IMPROVE_REPO_MAP = JSON.stringify(repoMap);
  if (Object.keys(projectMap).length) env.IMPROVE_PROJECT_MAP = JSON.stringify(projectMap);
  if (repoCatalog.length) env.SMITHERS_REPO_CATALOG = JSON.stringify(repoCatalog);

  return env;
}

export function loadRunnerConfigEnv(options = {}) {
  return runnerConfigEnv(readJson(runnerConfigPath(options), options));
}
