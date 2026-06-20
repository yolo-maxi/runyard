// Repo / project catalog for the Run form.
//
// Fran reported a workflow failing because he hand-typed the wrong repo. The
// fix is a curated, authenticated catalog the UI can offer as a selector
// instead of a free-text box. This helper reads ONLY explicitly configured,
// safe sources and returns friendly selector keys (`repo` / `project`) plus a
// default Hub entry.
//
// Hard security rules (see goal §5):
//   - Never expose raw runner-local filesystem paths. The map env vars map a
//     friendly key -> absolute path; we surface only the *key* and a label.
//   - Never expose secrets or arbitrary env. We read a fixed allowlist of env
//     vars and nothing else.
//   - Never scan the filesystem. The catalog is purely what an operator
//     configured.

const DEFAULT_REPO_KEY = "smithers-hub";

function cleanString(value) {
  return String(value ?? "").trim();
}

function parseJsonObject(raw) {
  const value = cleanString(raw);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* malformed config is ignored — a bad env var must not 500 the listing */
  }
  return null;
}

// IMPROVE_REPO_MAP / IMPROVE_PROJECT_MAP are key -> absolute path. We expose the
// keys (and treat the key as the label) but deliberately drop the path so a web
// caller can't enumerate the runner's private filesystem layout.
function keysFromMap(raw, selector) {
  const parsed = parseJsonObject(raw);
  if (!parsed || Array.isArray(parsed)) return [];
  return Object.keys(parsed)
    .map(cleanString)
    .filter(Boolean)
    .map((key) => ({ value: key, label: key, selector }));
}

// SMITHERS_REPO_CATALOG is an operator-curated list of *labels only* — never
// paths. It can be an array of objects or a plain key->label object.
function entriesFromCatalog(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return [];
  const rows = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([value, label]) => ({ value, label }));
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const value = cleanString(row.value ?? row.key ?? row.repo ?? row.project);
      if (!value) return null;
      const selector = row.project && !row.repo ? "project" : cleanString(row.selector) === "project" ? "project" : "repo";
      return {
        value,
        label: cleanString(row.label ?? row.name) || value,
        selector,
        // Description is the only free-text we echo back; keep it short and it
        // is operator-authored, so no path/secret leakage from runner state.
        ...(cleanString(row.description) ? { description: cleanString(row.description).slice(0, 200) } : {})
      };
    })
    .filter(Boolean);
}

// Build the safe catalog the /api/repo-options endpoint serves. `env` is
// injectable for tests.
export function buildRepoCatalog(env = process.env) {
  const defaultEntry = {
    value: DEFAULT_REPO_KEY,
    label: "Smithers Hub (default repo)",
    selector: "repo",
    default: true
  };

  const collected = [
    defaultEntry,
    ...entriesFromCatalog(env.SMITHERS_REPO_CATALOG),
    ...keysFromMap(env.IMPROVE_REPO_MAP, "repo"),
    ...keysFromMap(env.IMPROVE_PROJECT_MAP, "project")
  ];

  // De-dupe on selector+value, first writer wins (default + curated catalog
  // take precedence over bare map keys).
  const seen = new Set();
  const options = [];
  for (const entry of collected) {
    const dedupeKey = `${entry.selector}:${entry.value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    options.push(entry);
  }

  return {
    options,
    default: { selector: defaultEntry.selector, value: defaultEntry.value },
    // The raw repoDir escape hatch is always available but must be runner-local
    // and allowlisted; the UI shows this warning next to the manual field.
    repoDir: {
      allowed: true,
      warning:
        "Advanced: repoDir must be an absolute path that is runner-local and inside the runner's allowlisted improve roots. Prefer a configured repo/project above."
    }
  };
}
