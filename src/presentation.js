export const PROJECT_INPUT_KEYS = ["project", "projectName", "workspace", "repo", "repository", "githubRepo", "target", "subdomain", "preferredSubdomain"];
export const REPO_INPUT_KEYS = ["repo", "repository", "githubRepo", "repositoryUrl", "repoUrl", "GITHUB_REPOSITORY", "REPOSITORY", "REPO"];
export const PATH_INPUT_KEYS = ["path", "targetPath", "repoPath", "projectPath", "cwd", "workingDirectory", "directory", "PWD", "CWD"];
export const BRANCH_INPUT_KEYS = ["branch", "targetBranch", "baseBranch", "ref", "gitBranch", "GITHUB_REF_NAME", "BRANCH", "TARGET_BRANCH"];
export const TITLE_INPUT_KEYS = ["title", "name", "goal", "task", "prompt", "topic", "idea", "workPrompt", "question"];
export const DESCRIPTION_INPUT_KEYS = ["description", "summary", "notes", "scope", "constraints", "reason", "rationale", "context"];
export const CHANGE_INPUT_KEYS = ["workPrompt", "idea", "spec", "change", "changes", "task", "goal", "prompt", "description", "summary", "context", "notes"];
export const ACTION_INPUT_KEYS = ["proposedAction", "action", "operation", "command"];
export const ORIGIN_INPUT_KEYS = ["requestedBy", "requester", "originator", "user", "username", "owner", "actor", "source", "from"];

const CONTEXT_OBJECT_KEYS = ["context", "metadata", "env", "environment", "project", "git"];

export function firstString(input, keys) {
  if (!input || typeof input !== "object") return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function firstContextString(input, keys) {
  const direct = firstString(input, keys);
  if (direct) return direct;
  if (!input || typeof input !== "object") return "";
  for (const parentKey of CONTEXT_OBJECT_KEYS) {
    const parent = input[parentKey];
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      const nested = firstString(parent, keys);
      if (nested) return nested;
    }
  }
  return "";
}

export function uniqueNonempty(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

export function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).replace(/\s+\S*$/, "")}\u2026`;
}

export function normalizeOrigin(value) {
  if (!value) return null;
  if (typeof value === "string") return { label: value };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const cleaned = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item != null));
  if (!Object.keys(cleaned).length) return null;
  const label = cleaned.label || cleaned.name || cleaned.source || cleaned.from || cleaned.chat || cleaned.thread || "";
  return { ...cleaned, ...(label ? { label } : {}) };
}
