const state = {
  me: null,
  view: "home"
};

const $ = (selector) => document.querySelector(selector);
const content = $("#content");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);
}

function status(value) {
  return `<span class="status ${esc(value)}">${esc(value)}</span>`;
}

function json(value) {
  return `<pre class="json">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

// --- Deep links --------------------------------------------------------------
// Stable hash-routed deep links for every primary view. All helpers return the
// hash (e.g. `#runs/abc`) so anchor tags can drop them straight into `href`.
// `abs()` lifts a hash to a copy-pasteable absolute URL — used by share
// buttons. `parse()` decodes a hash into {segments, params} so routing can
// branch on sub-paths (`#runs/<id>/logs`) and query params alike.
const deepLinks = {
  base: () => `${location.origin}/app`,
  abs(hash) {
    if (!hash) return this.base();
    return `${this.base()}${hash.startsWith("#") ? hash : `#${hash}`}`;
  },
  parse(raw = location.hash || "") {
    const pathAndQuery = raw.replace(/^#/, "");
    const [pathPart, queryPart = ""] = pathAndQuery.split("?");
    const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(queryPart);
    return { raw: pathPart, segments, params, view: segments[0] || "home" };
  },
  home: () => "#runs",
  runs: () => "#runs",
  run: (id) => `#runs/${encodeURIComponent(id)}`,
  runLogs: (id) => `#runs/${encodeURIComponent(id)}/logs`,
  runArtifacts: (id) => `#runs/${encodeURIComponent(id)}/artifacts`,
  workflows: () => "#workflows",
  workflow: (slug) => `#workflows/${encodeURIComponent(slug)}`,
  workflowRuns: (slug) => `#workflows/${encodeURIComponent(slug)}/runs`,
  workflowEdit: (slug) => `#workflows/${encodeURIComponent(slug)}/edit`,
  workflowRun: (slug) => `#workflows/${encodeURIComponent(slug)}/run`,
  agents: () => "#agents/agents",
  skills: () => "#agents/skills",
  knowledge: () => "#agents/knowledge",
  agent: (slug) => `#agents/agents/${encodeURIComponent(slug)}`,
  skill: (slug) => `#agents/skills/${encodeURIComponent(slug)}`,
  knowledgeItem: (slug) => `#agents/knowledge/${encodeURIComponent(slug)}`,
  artifacts: () => "#artifacts",
  artifact: (id) => `#artifacts/${encodeURIComponent(id)}`,
  tokens: () => "#tokens",
  runners: () => "#runners",
  audit: () => "#audit",
  connect: () => "#connect",
  approvals: () => "#approvals",
  approval: (id) => `#approvals/${encodeURIComponent(id)}`,
  settings: () => "#settings"
};

// Expose so devtools, tests, and the server-served JS check can confirm the
// deep-link helpers actually shipped.
if (typeof window !== "undefined") {
  window.smithersDeepLinks = deepLinks;
}

// Inline "copy share link" button — emits an absolute URL for the given hash.
function shareButton(hash, label = "Copy link") {
  const url = deepLinks.abs(hash);
  return `<button type="button" class="share-link" data-copy="${esc(url)}" title="Copy shareable link" aria-label="${esc(label)}">🔗</button>`;
}

// --- Transient notifications -------------------------------------------------
function toast(message, kind = "info") {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3600);
}

function empty(message, hint = "") {
  return `<div class="empty"><p>${esc(message)}</p>${hint ? `<p class="muted">${hint}</p>` : ""}</div>`;
}

// --- Schema-driven form fields ----------------------------------------------
// Render a labeled control for one JSON-Schema property.
function schemaField(key, prop = {}, required = false) {
  const type = prop.type || "string";
  const hint = prop.description ? `<span class="field-hint">${esc(prop.description)}</span>` : "";
  const label = `${esc(key)}${required ? ' <span class="req">*</span>' : ""}`;
  let control;
  if (Array.isArray(prop.enum)) {
    control = `<select data-field="${esc(key)}" data-ftype="string">
      <option value="">—</option>
      ${prop.enum.map((opt) => `<option value="${esc(opt)}">${esc(opt)}</option>`).join("")}
    </select>`;
  } else if (type === "boolean") {
    control = `<input type="checkbox" data-field="${esc(key)}" data-ftype="boolean">`;
  } else if (type === "number" || type === "integer") {
    control = `<input type="number" data-field="${esc(key)}" data-ftype="number">`;
  } else if (type === "object" || type === "array") {
    control = `<textarea data-field="${esc(key)}" data-ftype="json" placeholder="${type === "array" ? "[]" : "{}"}"></textarea>`;
  } else {
    control = `<input type="text" data-field="${esc(key)}" data-ftype="string">`;
  }
  return `<label>${label}${hint}${control}<span class="field-error" data-error-for="${esc(key)}"></span></label>`;
}

function schemaForm(schema = {}) {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const keys = Object.keys(props);
  if (!keys.length) return "";
  return keys.map((key) => schemaField(key, props[key], required.has(key))).join("");
}

// Read structured fields back into an object, validating required + JSON fields. Returns {ok, values, errors}.
function collectSchemaInput(scope, schema = {}) {
  const required = new Set(schema.required || []);
  const values = {};
  const errors = {};
  scope.querySelectorAll("[data-field]").forEach((el) => {
    const key = el.dataset.field;
    const ftype = el.dataset.ftype;
    if (ftype === "boolean") {
      values[key] = el.checked;
      return;
    }
    const raw = el.value.trim();
    if (!raw) {
      if (required.has(key)) errors[key] = "required";
      return;
    }
    if (ftype === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) errors[key] = "must be a number";
      else values[key] = n;
    } else if (ftype === "json") {
      try {
        values[key] = JSON.parse(raw);
      } catch {
        errors[key] = "invalid JSON";
      }
    } else {
      values[key] = raw;
    }
  });
  return { ok: Object.keys(errors).length === 0, values, errors };
}

function showFieldErrors(scope, errors) {
  scope.querySelectorAll("[data-error-for]").forEach((el) => {
    el.textContent = errors[el.dataset.errorFor] || "";
  });
}

function toolbar(title, actions = "", hashForShare = "") {
  const share = hashForShare ? shareButton(hashForShare, "Copy link to this page") : "";
  return `<div class="toolbar"><h1>${esc(title)}${share}</h1><div class="toolbar-actions">${actions}</div></div>`;
}

// --- Routing: which sidebar item highlights for a given view ---------------
// home is the new app-home (Runs). Workflows = capabilities. Agents folds in
// the old Skills + Knowledge sections as sub-tabs. Other views live in the
// top-right Admin menu and don't claim a sidebar slot.
const PRIMARY_VIEWS = new Map([
  ["home", "home"],
  ["runs", "home"],
  ["dashboard", "home"],
  ["workflows", "workflows"],
  ["capabilities", "workflows"],
  ["agents", "agents"],
  ["skills", "agents"],
  ["knowledge", "agents"]
]);

function highlightSidebar(view) {
  const primary = PRIMARY_VIEWS.get(view) || "";
  document.querySelectorAll(".sidebar button").forEach((button) =>
    button.classList.toggle("active", button.dataset.view === primary)
  );
}

function closeAdminMenu() {
  const menu = document.getElementById("admin-menu");
  if (menu) menu.open = false;
}

function setView(view) {
  state.view = view;
  closeAdminMenu();
  location.hash = view;
  render().catch(showError);
}

function showError(error) {
  content.innerHTML = `<section class="panel"><h2>Something failed</h2><p class="muted">${esc(error.message)}</p></section>`;
}

async function boot() {
  try {
    const data = await api("/api/me");
    state.me = data.token;
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    state.view = location.hash.slice(1) || "home";
    // Bind every nav button (sidebar + admin dropdown) that declares a view.
    document.querySelectorAll("[data-view]").forEach((button) =>
      button.addEventListener("click", () => setView(button.dataset.view))
    );
    // Close the admin dropdown when the user clicks outside of it.
    document.addEventListener("click", (event) => {
      const menu = document.getElementById("admin-menu");
      if (menu && menu.open && !menu.contains(event.target)) menu.open = false;
    });
    $("#logout").addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST", body: {} });
      location.reload();
    });
    await render();
  } catch {
    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/token-login", { method: "POST", body: { token: $("#token").value } });
    location.reload();
  } catch (error) {
    toast(error.message || "Login failed", "error");
  }
});

async function render() {
  const route = deepLinks.parse("#" + (state.view || "home"));
  const { segments } = route;
  const view = route.view;
  highlightSidebar(view);
  if (view === "runs" && segments[1]) {
    const focus = segments[2] || ""; // "logs" | "artifacts" | ""
    return renderRunDetail(segments[1], { focus });
  }
  if (view === "home" || view === "runs" || view === "dashboard") return renderHome();
  if (view === "workflows" || view === "capabilities") {
    const slug = segments[1];
    const sub = segments[2] || "";
    if (slug) return renderWorkflowDetail(slug, { sub });
    await renderCapabilities();
    return;
  }
  if (view === "agents" || view === "skills" || view === "knowledge") {
    // Allow #agents/<tab>[/<slug>], plus legacy #skills / #knowledge hashes.
    let tab;
    let slug;
    if (view === "agents") {
      tab = segments[1] || "agents";
      slug = segments[2];
    } else {
      tab = view;
      slug = segments[1];
    }
    await renderAgents(tab);
    if (slug) await editItem(AGENT_TABS.find((t) => t.key === tab)?.endpoint || tab, slug);
    return;
  }
  if (view === "connect") return renderConnect();
  if (view === "approvals") return segments[1] ? renderApprovalDetail(segments[1]) : renderApprovals();
  if (view === "artifacts") return renderArtifacts(segments[1] || "");
  if (view === "runners") return renderRunners();
  if (view === "tokens") return renderTokens();
  if (view === "audit") return renderAudit();
  if (view === "settings") return renderSettings();
  return renderHome();
}

// --- Virtual artifact/log grouping ------------------------------------------
// Display-layer only: we build a human-readable identity folder
// (e.g. "Fran--software-audit--05-mar-26") from the run's metadata and use
// it as the visual grouping label for that run's artifacts and logs. The
// physical artifact storage (run_id + name on disk) is unchanged, so old
// runs and existing API consumers continue to work as-is.
function runUsername(run) {
  const input = run?.input || {};
  return input.user || input.owner || input.username || input.requester || input.requestedBy || "hub";
}

function runDateLabel(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}-${mon}-${yy}`;
}

function runFolderLabel(run) {
  const user = runUsername(run);
  const slug = run.capabilitySlug || "workflow";
  return `${user}--${slug}--${runDateLabel(run.createdAt)}`;
}

const MIME_EXT = {
  "text/markdown": ".md",
  "text/plain": ".txt",
  "application/json": ".json",
  "text/html": ".html",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "text/csv": ".csv",
  "application/zip": ".zip",
  "application/x-yaml": ".yaml",
  "text/x-log": ".log"
};

// Best-effort display name; underlying artifact.name on disk is unchanged.
function artifactDisplayName(artifact) {
  let name = (artifact?.name || "artifact").trim() || "artifact";
  const generic = /^(artifact|blob|result|output|file|data)$/i.test(name);
  const hasDot = name.includes(".");
  if ((generic || !hasDot) && artifact?.mimeType && MIME_EXT[artifact.mimeType]) {
    const ext = MIME_EXT[artifact.mimeType];
    if (!name.toLowerCase().endsWith(ext)) name = `${name}${ext}`;
  }
  if (artifact?.kind && !name.toLowerCase().startsWith(`${artifact.kind.toLowerCase()}/`)) {
    return `${artifact.kind}/${name}`;
  }
  return name;
}

function formatBytes(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const ACTIVE_STATUSES = new Set(["queued", "assigned", "running", "waiting_approval", "pending"]);

function isActiveRun(run) {
  return ACTIVE_STATUSES.has(run.status);
}

// --- Run summary fallbacks (client-side mirror of server.js helpers) --------
// The API now sends derived `title` / `description` / `project` / `branch`
// fields, but we keep these locally too so cards rendered from stale clients
// or third-party data still get sensible defaults.
const PROJECT_INPUT_KEYS = ["project", "repo", "repository", "target", "targetPath", "path", "subdomain", "preferredSubdomain"];
const BRANCH_INPUT_KEYS = ["branch", "targetBranch", "ref", "gitBranch"];
const TITLE_INPUT_KEYS = ["title", "name", "goal", "task", "prompt", "topic", "idea", "workPrompt", "question"];
const DESCRIPTION_INPUT_KEYS = ["description", "summary", "notes", "scope", "constraints", "reason", "rationale", "context"];

function firstInputString(input, keys) {
  if (!input || typeof input !== "object") return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function runTitle(run) {
  if (run?.title) return run.title;
  const fromInput = firstInputString(run?.input, TITLE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 90);
  return run?.capabilityName || run?.capabilitySlug || "Run";
}

function runDescription(run) {
  if (run?.description) return run.description;
  const fromInput = firstInputString(run?.input, DESCRIPTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 240);
  const titleField = firstInputString(run?.input, TITLE_INPUT_KEYS);
  if (titleField && titleField.length > 90) return truncate(titleField, 240);
  const parts = [];
  if (run?.capabilityName) parts.push(run.capabilityName);
  if (run?.currentStep) parts.push(run.currentStep);
  return truncate(parts.join(" — "), 240);
}

function runProject(run) {
  return run?.project || firstInputString(run?.input, PROJECT_INPUT_KEYS);
}

function runBranch(run) {
  return run?.branch || firstInputString(run?.input, BRANCH_INPUT_KEYS);
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function runDurationMs(run) {
  if (run?.durationMs != null) return run.durationMs;
  if (!run?.createdAt) return null;
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = Date.parse(run.completedAt || Date.now());
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function relativeTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// Renders a horizontal pill list. Items can be strings or `{label, href}`.
// `link` is a function that derives a deep link from a string slug.
function pills(items, { kind = "pill", link = null } = {}) {
  if (!items || !items.length) return "";
  return `<ul class="pills" role="list">${items
    .map((item) => {
      const label = typeof item === "string" ? item : item.label || item.slug || item.name;
      const href = typeof item === "object" && item.href ? item.href : link ? link(item) : "";
      const body = href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label);
      return `<li class="${esc(kind)}">${body}</li>`;
    })
    .join("")}</ul>`;
}

function runCard(run, artifacts = []) {
  const active = isActiveRun(run);
  const folder = runFolderLabel(run);
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const dur = runDurationMs(run);
  const durStr = formatDuration(dur);
  const created = relativeTime(run.createdAt);
  const chipsHtml = (project || branch || run.workflowVersion)
    ? `<div class="run-card-chips">
        ${project ? `<span class="chip chip-project" title="Project / target">📦 ${esc(project)}</span>` : ""}
        ${branch ? `<span class="chip chip-branch" title="Branch">🌿 ${esc(branch)}</span>` : ""}
        ${run.workflowVersion ? `<span class="chip chip-version" title="Workflow version">v${esc(run.workflowVersion)}</span>` : ""}
      </div>`
    : "";
  const artifactPreview = !active && artifacts.length
    ? `<ul class="artifact-list">
        ${artifacts.slice(0, 3).map((a) => `<li><a href="${esc(deepLinks.artifact(a.id))}">${esc(artifactDisplayName(a))}</a> <a class="muted artifact-dl" href="/api/artifacts/${esc(a.id)}/download" target="_blank">download</a> <span class="muted">${esc(formatBytes(a.sizeBytes))}</span></li>`).join("")}
        ${artifacts.length > 3 ? `<li class="muted"><a href="${esc(deepLinks.runArtifacts(run.id))}">+${artifacts.length - 3} more</a></li>` : ""}
      </ul>`
    : "";
  return `<article class="run-card ${active ? "active" : "done"} ${esc(run.status)}" id="run-${esc(run.id)}">
    <header class="run-card-head">
      ${active ? '<span class="run-pulse" aria-hidden="true"></span>' : '<span class="run-folder-icon" aria-hidden="true">📁</span>'}
      ${status(run.status)}
      ${slug ? `<a class="run-cap-link" href="${esc(deepLinks.workflow(slug))}" title="Open this workflow">${esc(run.capabilityName || slug)}</a>` : ""}
      <span class="run-folder" title="Display-only grouping">${esc(folder)}</span>
      ${shareButton(deepLinks.run(run.id), "Copy share link to this run")}
    </header>
    <h3 class="run-card-title"><a href="${esc(deepLinks.run(run.id))}">${esc(title)}</a></h3>
    <p class="muted run-desc">${esc(description)}</p>
    ${chipsHtml}
    <p class="muted run-meta">
      <span class="run-step">${esc(run.currentStep || (active ? "starting…" : "—"))}</span>
      <span class="run-timing">${esc(created)}${durStr ? ` · ${esc(durStr)}` : ""}</span>
    </p>
    ${artifactPreview}
    <footer class="run-card-foot">
      <a class="button" href="${esc(slug ? deepLinks.workflow(slug) : deepLinks.workflows())}">Workflow</a>
      <a class="button" href="${esc(deepLinks.runLogs(run.id))}">Run log</a>
      <a class="button" href="${esc(deepLinks.runArtifacts(run.id))}">Artifacts</a>
    </footer>
  </article>`;
}

// --- Home: active runs up top, completed below ------------------------------
async function renderHome() {
  const [runsData, dash] = await Promise.all([
    api("/api/runs?limit=100"),
    api("/api/dashboard").catch(() => ({ stats: {}, pendingApprovals: [] }))
  ]);
  const runs = runsData.runs || [];
  const active = runs.filter(isActiveRun);
  const completed = runs.filter((r) => !isActiveRun(r));
  // Best-effort artifact bucket — if the call fails we just skip the preview.
  const artifactsByRun = new Map();
  try {
    const arts = await api("/api/artifacts");
    for (const a of arts.artifacts || []) {
      if (!artifactsByRun.has(a.runId)) artifactsByRun.set(a.runId, []);
      artifactsByRun.get(a.runId).push(a);
    }
  } catch {
    // non-fatal
  }
  const stats = dash.stats || {};
  const pending = dash.pendingApprovals || [];
  const gettingStarted = (runs.length === 0) && !active.length;
  content.innerHTML = `${toolbar("Runs", `<button id="home-new-run">Run a workflow</button>`, deepLinks.home())}
    <p class="muted deep-link-hint">Every page, run, workflow, and artifact has a stable URL — click 🔗 to copy a shareable link.</p>
    ${gettingStarted ? empty("No runs yet.", "Pick a workflow and run it, or start a runner to execute work. Head to Workflows to begin.") : ""}
    <section class="stats home-stats">
      ${Object.entries({
        "Active runs": active.length,
        Workflows: stats.capabilities ?? 0,
        "Total runs": stats.runs ?? runs.length,
        Artifacts: stats.artifacts ?? 0,
        "Pending approvals": pending.length
      }).map(([label, value]) => `<div class="stat"><strong>${esc(String(value))}</strong><span class="muted">${esc(label)}</span></div>`).join("")}
    </section>
    <h2 class="section-heading">Active <span class="muted">${active.length} live</span></h2>
    ${active.length
      ? `<section class="run-grid live">${active.map((run) => runCard(run, artifactsByRun.get(run.id) || [])).join("")}</section>`
      : `<p class="muted run-empty">No active runs right now. Start one from <a href="${esc(deepLinks.workflows())}">Workflows</a>.</p>`}
    <h2 class="section-heading">Recent &amp; completed</h2>
    ${completed.length
      ? `<section class="run-grid">${completed.slice(0, 30).map((run) => runCard(run, artifactsByRun.get(run.id) || [])).join("")}</section>`
      : `<p class="muted">Completed runs and their artifacts will appear here.</p>`}
    ${pending.length ? `<h2 class="section-heading">Pending approvals</h2>
      <section class="panel">${approvalList(pending)}</section>` : ""}`;
  $("#home-new-run").addEventListener("click", () => setView("workflows"));
  document.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.approve, "approve", { rerender: "none" }).then(() => render().catch(showError))));
  document.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.reject, "reject", { rerender: "none" }).then(() => render().catch(showError))));
  bindCopy();
}

function runsTable(runs) {
  if (!runs.length) return `<p class="muted">No runs yet.</p>`;
  return `<table class="table"><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Step</th><th>Created</th></tr></thead><tbody>
    ${runs.map((run) => `<tr><td data-label="Run"><a href="${esc(deepLinks.run(run.id))}" data-run="${esc(run.id)}">${esc(run.id)}</a></td><td data-label="Workflow">${esc(run.capabilityName)}</td><td data-label="Status">${status(run.status)}</td><td data-label="Step">${esc(run.currentStep)}</td><td data-label="Created">${esc(run.createdAt)}</td></tr>`).join("")}
  </tbody></table>`;
}

async function renderCapabilities() {
  const data = await api("/api/capabilities");
  content.innerHTML = `${toolbar("Workflows", `<button id="new-cap">New Workflow</button>`, deepLinks.workflows())}
    <p class="muted">A workflow is a capability your agents can invoke. They appear as MCP tools and as launchable buttons here. Each workflow has a shareable link — open 🔗 to copy.</p>
    ${data.capabilities.length ? `<div class="grid">
      ${data.capabilities.map((cap) => {
        const skills = (cap.requiredSkills || []).slice(0, 4);
        const agents = (cap.requiredAgents || []).slice(0, 4);
        const tags = (cap.requiredRunnerTags || []).slice(0, 4);
        return `<article class="item workflow-card" id="workflow-${esc(cap.slug)}">
          <h3><a href="${esc(deepLinks.workflow(cap.slug))}">${esc(cap.name)}</a> ${shareButton(deepLinks.workflow(cap.slug), `Copy share link to ${cap.name}`)}</h3>
          <p class="muted workflow-desc">${esc(cap.description)}</p>
          <p class="workflow-meta">${esc(cap.category)} · v${cap.version} · ${cap.enabled ? "enabled" : "disabled"}${cap.approvalPolicy?.required ? " · needs approval" : ""}</p>
          ${agents.length ? `<div class="pill-row"><span class="pill-label">Agents</span>${pills(agents)}</div>` : ""}
          ${skills.length ? `<div class="pill-row"><span class="pill-label">Skills</span>${pills(skills)}</div>` : ""}
          ${tags.length ? `<div class="pill-row"><span class="pill-label">Runner tags</span>${pills(tags, { kind: "pill tag" })}</div>` : ""}
          <div class="toolbar-actions">
            <a class="button" href="${esc(deepLinks.workflow(cap.slug))}">Open</a>
            <button data-run="${esc(cap.slug)}" class="primary">Run</button>
            <button data-edit-cap="${esc(cap.slug)}">Edit</button>
          </div>
        </article>`;
      }).join("")}
    </div>` : empty("No workflows yet.", "Click New Workflow to define the first action agents can run.")}
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => setView(`workflows/${button.dataset.run}/run`)));
  document.querySelectorAll("[data-edit-cap]").forEach((button) => button.addEventListener("click", () => editCapability(button.dataset.editCap)));
  $("#new-cap").addEventListener("click", () => editCapability());
  bindCopy();
}

// --- Workflow detail page ---------------------------------------------------
// Renders the rich detail view for one workflow: description, required
// agents/skills/runner tags, approval policy, code/entry, latest runs, and
// an inline "Run this workflow" form. The Edit modal is reachable from the
// page header so editing is one click away without leaving the context.
async function renderWorkflowDetail(slug, { sub = "" } = {}) {
  let cap;
  try {
    const data = await api(`/api/capabilities/${slug}`);
    cap = data.capability;
  } catch (error) {
    content.innerHTML = `${toolbar("Workflow", "", deepLinks.workflow(slug))}<section class="panel"><p class="muted">${esc(error.message)}</p><p><a href="${esc(deepLinks.workflows())}">Back to workflows</a></p></section>`;
    return;
  }
  let runs = [];
  try {
    const runsData = await api(`/api/runs?capability=${encodeURIComponent(slug)}&limit=20`);
    runs = runsData.runs || [];
  } catch {
    // non-fatal
  }
  const skills = cap.requiredSkills || [];
  const agents = cap.requiredAgents || [];
  const tags = cap.requiredRunnerTags || [];
  const workflow = cap.workflow || {};
  const approval = cap.approvalPolicy || {};
  const entryLabel = workflow.entry || workflow.name || (workflow.type ? `${workflow.type}` : "");
  const headerActions = `
    <button id="wf-run" class="primary">Run this workflow</button>
    <button id="wf-edit">Edit</button>
    <a class="button" href="${esc(deepLinks.workflows())}">All workflows</a>
  `;
  content.innerHTML = `${toolbar(cap.name, headerActions, deepLinks.workflow(slug))}
    <p class="muted workflow-detail-desc">${esc(cap.description || "No description.")}</p>
    <p class="workflow-meta-row muted">
      <span>${esc(cap.category || "General")}</span>
      <span>·</span>
      <span>v${esc(cap.version)}</span>
      <span>·</span>
      <span>${cap.enabled ? "enabled" : "disabled"}</span>
      ${approval.required ? `<span>·</span><span class="status waiting_approval">needs approval</span>` : ""}
    </p>
    <section class="split">
      <div class="panel" id="panel-wf-detail">
        ${agents.length ? `<h3>Required agents</h3>${pills(agents, { link: (s) => deepLinks.agent(s) })}` : ""}
        ${skills.length ? `<h3>Required skills</h3>${pills(skills, { link: (s) => deepLinks.skill(s) })}` : ""}
        ${tags.length ? `<h3>Runner tags</h3>${pills(tags, { kind: "pill tag" })}` : ""}
        <h3>Approval policy</h3>
        ${approval.required
          ? `<p class="notice">Approval required before each run.${approval.reason ? ` ${esc(approval.reason)}` : ""}</p>`
          : `<p class="muted">No approval required — runs start as soon as a matching runner picks them up.</p>`}
        <h3>Workflow entry</h3>
        ${entryLabel
          ? `<p><span class="kbd">${esc(entryLabel)}</span>${workflow.engine ? ` <span class="muted">· engine ${esc(workflow.engine)}</span>` : ""}</p>`
          : `<p class="muted">No explicit entry registered.</p>`}
        <details class="advanced">
          <summary>Workflow contract (JSON)</summary>
          ${json({ inputSchema: cap.inputSchema || {}, outputSchema: cap.outputSchema || {}, workflow, requiredSkills: skills, requiredAgents: agents, requiredRunnerTags: tags, approvalPolicy: approval })}
        </details>
      </div>
      <div class="panel" id="panel-wf-side">
        <h3>Deep link</h3>
        <div class="copy-row"><input readonly value="${esc(deepLinks.abs(deepLinks.workflow(slug)))}"><button data-copy="${esc(deepLinks.abs(deepLinks.workflow(slug)))}">Copy</button></div>
        <h3>Latest runs ${shareButton(deepLinks.workflowRuns(slug), "Copy share link to this workflow's runs")}</h3>
        ${runs.length ? workflowRunsList(runs.slice(0, 8)) : `<p class="muted">No runs yet.</p>`}
        ${runs.length > 8 ? `<p class="muted"><a href="${esc(deepLinks.workflowRuns(slug))}">See all ${runs.length}</a></p>` : ""}
      </div>
    </section>
    <section id="editor" class="panel hidden"></section>`;
  $("#wf-run").addEventListener("click", () => setView(`workflows/${slug}/run`));
  $("#wf-edit").addEventListener("click", () => editCapability(slug));
  bindCopy();
  if (sub === "run") {
    await showRunForm(slug);
  } else if (sub === "edit") {
    await editCapability(slug);
  } else if (sub === "runs") {
    $("#panel-wf-side")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function workflowRunsList(runs) {
  return `<ul class="wf-run-list">${runs.map((run) => {
    const title = runTitle(run);
    const dur = formatDuration(runDurationMs(run));
    const project = runProject(run);
    const branch = runBranch(run);
    return `<li class="wf-run-row">
      <a href="${esc(deepLinks.run(run.id))}" class="wf-run-title">${esc(title)}</a>
      <span class="wf-run-status">${status(run.status)}</span>
      <span class="muted wf-run-when">${esc(relativeTime(run.createdAt))}${dur ? ` · ${esc(dur)}` : ""}</span>
      ${project ? `<span class="chip chip-project">📦 ${esc(project)}</span>` : ""}
      ${branch ? `<span class="chip chip-branch">🌿 ${esc(branch)}</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

async function showRunForm(slug) {
  const data = await api(`/api/capabilities/${slug}`);
  const cap = data.capability;
  const schema = cap.inputSchema || {};
  const hasFields = Object.keys(schema.properties || {}).length > 0;
  const approval = cap.approvalPolicy?.required;
  const sample = Object.fromEntries(Object.entries(schema.properties || {}).map(([key]) => [key, ""]));
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  editor.innerHTML = `<h2>Run ${esc(cap.name)} ${shareButton(deepLinks.workflow(slug), `Copy share link to ${cap.name}`)}</h2>
    <p class="muted">${esc(cap.description || "")}</p>
    <p class="muted"><span class="kbd">${esc(deepLinks.abs(deepLinks.workflow(slug)))}</span></p>
    ${approval ? `<p class="notice">This workflow requires approval before it runs.${cap.approvalPolicy?.reason ? ` ${esc(cap.approvalPolicy.reason)}` : ""}</p>` : ""}
    <form id="run-form" class="form-grid">
      ${hasFields ? schemaForm(schema) : `<label>Input JSON<textarea data-field="__raw" data-ftype="json" placeholder="{}">{}</textarea><span class="field-hint">This workflow has no declared input schema. Provide raw JSON.</span><span class="field-error" data-error-for="__raw"></span></label>`}
      ${hasFields ? `<details class="advanced"><summary>Edit as raw JSON instead</summary><label><textarea id="run-raw" data-ftype="json" placeholder="{}">${esc(JSON.stringify(sample, null, 2))}</textarea></label></details>` : ""}
      <button class="primary" type="submit">Create Run</button>
    </form>
    <details class="advanced"><summary>Workflow contract</summary>${json(cap)}</details>`;
  bindCopy();
  const form = $("#run-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let input;
    const rawEl = $("#run-raw");
    const advancedOpen = rawEl && rawEl.closest("details")?.open;
    try {
      if (!hasFields) {
        input = JSON.parse(form.querySelector('[data-field="__raw"]').value || "{}");
      } else if (advancedOpen) {
        input = JSON.parse(rawEl.value || "{}");
      } else {
        const collected = collectSchemaInput(form, schema);
        showFieldErrors(form, collected.errors);
        if (!collected.ok) return toast("Please fix the highlighted fields", "error");
        input = collected.values;
      }
    } catch {
      return toast("Input is not valid JSON", "error");
    }
    try {
      const result = await api(`/api/capabilities/${slug}/run`, { method: "POST", body: { input } });
      toast(`Run created${approval ? " — pending approval" : ""}`, "ok");
      location.hash = deepLinks.run(result.run.id).slice(1);
      state.view = `runs/${result.run.id}`;
      await render();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function editCapability(slug = "") {
  const cap = slug
    ? (await api(`/api/capabilities/${slug}`)).capability
    : { name: "", slug: "", description: "", category: "General", keywords: [], inputSchema: {}, outputSchema: {}, requiredRunnerTags: [], requiredSkills: [], requiredAgents: [], approvalPolicy: {}, workflow: { type: "builtin", name: "" }, enabled: true };
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"} Workflow</h2>
    <form id="cap-form" class="form-grid">
      <label>Name <span class="req">*</span><input id="cap-name" value="${esc(cap.name)}" required></label>
      <label>Slug${slug ? "" : ' <span class="field-hint">Leave blank to derive from the name.</span>'}<input id="cap-slug" value="${esc(cap.slug)}" ${slug ? "disabled" : ""}></label>
      <label>Description<textarea id="cap-description">${esc(cap.description)}</textarea></label>
      <label>Category<input id="cap-category" value="${esc(cap.category || "General")}"></label>
      <label>Keywords<input id="cap-keywords" value="${esc((cap.keywords || []).join(", "))}"><span class="field-hint">Comma-separated.</span></label>
      <label>Required runner tags<input id="cap-tags" value="${esc((cap.requiredRunnerTags || []).join(", "))}"><span class="field-hint">Comma-separated. Only runners with all these tags can execute it.</span></label>
      <label class="inline"><input type="checkbox" id="cap-enabled" ${cap.enabled === false ? "" : "checked"}> Enabled</label>
      <label class="inline"><input type="checkbox" id="cap-approval" ${cap.approvalPolicy?.required ? "checked" : ""}> Require approval before running</label>
      <label>Approval reason<input id="cap-approval-reason" value="${esc(cap.approvalPolicy?.reason || "")}"></label>
      <details class="advanced"><summary>Advanced: input/output schema &amp; workflow (JSON)</summary>
        <label><textarea id="cap-json">${esc(JSON.stringify({ inputSchema: cap.inputSchema || {}, outputSchema: cap.outputSchema || {}, workflow: cap.workflow || {}, requiredSkills: cap.requiredSkills || [], requiredAgents: cap.requiredAgents || [] }, null, 2))}</textarea></label>
      </details>
      <button class="primary" type="submit">Save Workflow</button>
    </form>`;
  $("#cap-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let advanced = {};
    try {
      advanced = JSON.parse($("#cap-json").value || "{}");
    } catch {
      return toast("Advanced JSON is invalid", "error");
    }
    const name = $("#cap-name").value.trim();
    if (!name) return toast("Name is required", "error");
    const payload = {
      ...cap,
      ...advanced,
      name,
      slug: slug || $("#cap-slug").value.trim() || undefined,
      description: $("#cap-description").value,
      category: $("#cap-category").value.trim() || "General",
      keywords: $("#cap-keywords").value.split(",").map((k) => k.trim()).filter(Boolean),
      requiredRunnerTags: $("#cap-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      enabled: $("#cap-enabled").checked,
      approvalPolicy: $("#cap-approval").checked ? { required: true, reason: $("#cap-approval-reason").value.trim() } : { required: false }
    };
    try {
      const saved = slug
        ? await api(`/api/capabilities/${slug}`, { method: "PATCH", body: payload })
        : await api("/api/capabilities", { method: "POST", body: payload });
      toast("Workflow saved", "ok");
      // If we were editing from a workflow's detail page, return the user
      // there (with the editor closed) instead of bouncing back to the list
      // — keeps Edit feeling inline rather than modal.
      const segments = deepLinks.parse().segments;
      const onDetail = segments[0] === "workflows" && segments[1];
      const targetSlug = saved?.capability?.slug || slug;
      if (onDetail && targetSlug) {
        setView(`workflows/${targetSlug}`);
      } else {
        await renderCapabilities();
      }
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function renderRunDetail(runId, { focus = "" } = {}) {
  const data = await api(`/api/runs/${runId}`);
  const run = data.run;
  const folder = runFolderLabel(run);
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const dur = runDurationMs(run);
  const durStr = formatDuration(dur);
  const focusHint = focus === "logs"
    ? `<p class="muted">Linked directly to this run's log.</p>`
    : focus === "artifacts"
      ? `<p class="muted">Linked directly to this run's artifacts.</p>`
      : "";
  const chips = [];
  if (project) chips.push(`<span class="chip chip-project">📦 ${esc(project)}</span>`);
  if (branch) chips.push(`<span class="chip chip-branch">🌿 ${esc(branch)}</span>`);
  if (run.workflowVersion) chips.push(`<span class="chip chip-version">workflow v${esc(run.workflowVersion)}</span>`);
  if (run.runnerId) chips.push(`<span class="chip chip-runner">🛠 ${esc(run.runnerId)}</span>`);
  content.innerHTML = `${toolbar(title, `<a class="button" href="${esc(slug ? deepLinks.workflow(slug) : deepLinks.workflows())}">Workflow</a>
      <a class="button" href="${esc(deepLinks.runLogs(run.id))}">Run log</a>
      <a class="button" href="${esc(deepLinks.runArtifacts(run.id))}">Artifacts</a>
      <button id="cancel-run" class="danger">Cancel</button>`, deepLinks.run(run.id))}
    <p class="run-detail-sub">
      ${status(run.status)}
      ${slug ? `<a class="run-cap-link" href="${esc(deepLinks.workflow(slug))}">${esc(run.capabilityName || slug)}</a>` : ""}
      <span class="run-id-mono" title="Run id">${esc(run.id)}</span>
      <span class="muted">${esc(relativeTime(run.createdAt))}${durStr ? ` · ${esc(durStr)}` : ""}</span>
    </p>
    <p class="run-detail-desc">${esc(description)}</p>
    ${chips.length ? `<p class="run-detail-chips">${chips.join("")}</p>` : ""}
    <p class="run-folder-banner"><span class="run-folder">📁 ${esc(folder)}</span> <span class="muted">— display-only grouping for this run's artifacts &amp; logs</span></p>
    ${focusHint}
    <section class="split">
      <div class="panel" id="panel-logs">
        <h2>Run log ${shareButton(deepLinks.runLogs(run.id), "Copy share link to this run's log")}</h2>
        <p class="muted">${esc(run.currentStep || "—")}</p>
        <h3>Timeline</h3>
        <div class="timeline">${data.events.map((event) => `<div class="event"><time>${esc(event.createdAt)}</time><strong>${esc(event.type)}</strong><br>${esc(event.message)}</div>`).join("")}</div>
      </div>
      <div class="panel" id="panel-artifacts">
        <h3>Input</h3>${json(run.input)}
        <h3>Output</h3>${json(run.output)}
        <h3>Artifacts ${shareButton(deepLinks.runArtifacts(run.id), "Copy share link to this run's artifacts")}</h3>
        ${artifactList(data.artifacts)}
      </div>
    </section>`;
  $("#cancel-run").addEventListener("click", async () => {
    await api(`/api/runs/${run.id}/cancel`, { method: "POST", body: { reason: "Cancelled from Web Hub" } });
    await renderRunDetail(run.id, { focus });
  });
  bindCopy();
  // Honor the sub-route by bringing the relevant panel into view.
  if (focus === "logs") $("#panel-logs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (focus === "artifacts") $("#panel-artifacts")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function artifactList(artifacts) {
  if (!artifacts.length) return `<p class="muted">No artifacts.</p>`;
  return `<ul class="artifact-list">${artifacts.map((artifact) => `<li id="artifact-${esc(artifact.id)}"><a href="/api/artifacts/${esc(artifact.id)}/download" target="_blank">${esc(artifactDisplayName(artifact))}</a> ${shareButton(deepLinks.artifact(artifact.id), "Copy share link to this artifact")} <span class="muted">${esc(formatBytes(artifact.sizeBytes))}${artifact.mimeType ? ` · ${esc(artifact.mimeType)}` : ""}</span></li>`).join("")}</ul>`;
}

function approvalContext(approval) {
  return approval?.context || {};
}

function approvalWorkflowLabel(approval) {
  const workflow = approvalContext(approval).workflow;
  if (!workflow) return approval?.payload?.capability || "Unknown workflow";
  return `${workflow.name || workflow.slug || "Workflow"}${workflow.slug ? ` (${workflow.slug})` : ""}`;
}

function approvalRunLink(approval) {
  const run = approvalContext(approval).run;
  if (!run && !approval.deepLinkRun) return "";
  const href = run?.deepLink || approval.deepLinkRun;
  const label = run?.title || approval.runId || "Linked run";
  return `<a class="button" href="${esc(href)}">Open run</a><span class="muted approval-run-id">${esc(approval.runId || run?.id || "")}</span>`;
}

function approvalDeployLine(approval) {
  const deploy = approvalContext(approval).deploy;
  if (deploy == null) return "";
  return `<p><span class="muted">Deploy</span><br><span class="chip ${deploy ? "chip-runner" : "chip-version"}">${deploy ? "yes" : "no"}</span></p>`;
}

function approvalList(approvals) {
  if (!approvals.length) return `<p class="muted">No pending approvals.</p>`;
  return `<div class="approval-list">${approvals.map((approval) => `<article class="item approval-card" id="approval-${esc(approval.id)}">
    <header class="approval-card-head">
      ${status(approval.status)}
      <span class="muted">${esc(approvalWorkflowLabel(approval))}</span>
      ${shareButton(deepLinks.approval(approval.id), "Copy share link to this approval")}
    </header>
    <h3><a href="${esc(deepLinks.approval(approval.id))}">${esc(approval.title)}</a></h3>
    <p class="muted approval-card-desc">${esc(approval.description || "No description provided.")}</p>
    <p class="muted approval-card-meta">${esc(approval.runId || "No linked run")}</p>
    <div class="toolbar-actions">
      <a class="button" href="${esc(deepLinks.approval(approval.id))}">Open approval</a>
      ${approval.status === "pending" ? `<button data-approve="${esc(approval.id)}" class="primary">Approve</button>
        <button data-reject="${esc(approval.id)}" class="danger">Reject</button>` : ""}
    </div>
  </article>`).join("")}</div>`;
}

async function renderApprovals() {
  const data = await api("/api/approvals");
  content.innerHTML = `${toolbar("Approvals", "", deepLinks.approvals())}${approvalList(data.approvals)}`;
  document.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.approve, "approve")));
  document.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.reject, "reject")));
  bindCopy();
}

async function renderApprovalDetail(id) {
  let approval;
  try {
    approval = (await api(`/api/approvals/${encodeURIComponent(id)}`)).approval;
  } catch (error) {
    content.innerHTML = `${toolbar("Approval", `<a class="button" href="${esc(deepLinks.approvals())}">All approvals</a>`, deepLinks.approval(id))}
      <section class="panel"><p class="muted">${esc(error.message)}</p></section>`;
    return;
  }
  const context = approvalContext(approval);
  const workflow = context.workflow;
  const run = context.run;
  const canResolve = approval.status === "pending";
  const actions = `<a class="button" href="${esc(deepLinks.approvals())}">All approvals</a>${run ? ` <a class="button" href="${esc(run.deepLink)}">Open run</a>` : ""}`;
  content.innerHTML = `${toolbar(approval.title, actions, deepLinks.approval(approval.id))}
    <p class="approval-detail-sub">
      ${status(approval.status)}
      <span class="run-id-mono">${esc(approval.id)}</span>
      <span class="muted">${esc(approval.createdAt || "")}</span>
    </p>
    <section class="approval-detail-grid">
      <div class="panel approval-main">
        <h2>Context</h2>
        <p class="approval-description">${esc(approval.description || "No description provided.")}</p>
        <div class="approval-facts">
          <p><span class="muted">Workflow</span><br>${workflow?.deepLink ? `<a href="${esc(workflow.deepLink)}">${esc(approvalWorkflowLabel(approval))}</a>` : esc(approvalWorkflowLabel(approval))}</p>
          ${approvalDeployLine(approval)}
          <p><span class="muted">Requested by</span><br>${esc(approval.requestedBy || "workflow")}</p>
          <p><span class="muted">Run</span><br>${approvalRunLink(approval) || `<span class="muted">No linked run</span>`}</p>
        </div>
        ${run ? `<h3>Linked run</h3>
          <p><strong>${esc(run.title || approval.runId)}</strong> ${status(run.status)}</p>
          <p class="muted">${esc(run.description || run.currentStep || "")}</p>` : ""}
        <h3>What happens</h3>
        <p class="notice">${esc(context.whatHappensIfApproved || "Approving marks this approval approved.")}</p>
        <p class="muted">${esc(context.whatHappensIfRejected || "Rejecting marks this approval rejected.")}</p>
        ${canResolve ? `<div class="approval-decision">
          <label>Decision note<textarea id="approval-comment" placeholder="Optional note for the audit log"></textarea></label>
          <div class="toolbar-actions">
            <button id="approval-approve" class="primary">Approve</button>
            <button id="approval-reject" class="danger">Reject</button>
          </div>
        </div>` : `<p class="muted">Resolved by ${esc(approval.resolvedBy || "unknown")} at ${esc(approval.resolvedAt || "unknown")}${approval.comment ? `: ${esc(approval.comment)}` : ""}</p>`}
      </div>
      <aside class="panel approval-side">
        <h2>Approval link</h2>
        <div class="copy-row"><input readonly value="${esc(deepLinks.abs(deepLinks.approval(approval.id)))}"><button data-copy="${esc(deepLinks.abs(deepLinks.approval(approval.id)))}">Copy</button></div>
        <h3>Payload summary</h3>
        ${json(approval.payloadSummary || approval.payload || {})}
      </aside>
    </section>`;
  if (canResolve) {
    $("#approval-approve").addEventListener("click", () => resolveApproval(approval.id, "approve", { rerender: "detail" }));
    $("#approval-reject").addEventListener("click", () => resolveApproval(approval.id, "reject", { rerender: "detail" }));
  }
  bindCopy();
}

async function resolveApproval(id, decision, { rerender = "list" } = {}) {
  const comment = $("#approval-comment")?.value?.trim() || "Resolved from Web Hub";
  await api(`/api/approvals/${id}/${decision}`, { method: "POST", body: { comment } });
  toast(decision === "approve" ? "Approval granted" : "Approval rejected", "ok");
  if (rerender === "detail") return renderApprovalDetail(id);
  if (rerender === "none") return null;
  return renderApprovals();
}

async function renderArtifacts(focusId = "") {
  const data = await api("/api/artifacts");
  content.innerHTML = `${toolbar("Artifacts", "", deepLinks.artifacts())}<section class="panel">${artifactList(data.artifacts)}</section>`;
  bindCopy();
  if (focusId) focusElement(`artifact-${focusId}`);
}

// Scroll a deep-linked item into view and briefly highlight it so the user
// sees what they landed on.
function focusElement(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("link-focus");
  setTimeout(() => el.classList.remove("link-focus"), 2200);
}

async function renderRunners() {
  const data = await api("/api/runners");
  content.innerHTML = `${toolbar("Runners", "", deepLinks.runners())}<section class="panel">
    ${data.runners.length ? `<table class="table"><thead><tr><th>Name</th><th>Status</th><th>Tags</th><th>Last heartbeat</th></tr></thead><tbody>
      ${data.runners.map((runner) => `<tr><td data-label="Name">${esc(runner.name)}<br><span class="muted">${esc(runner.id)}</span></td><td data-label="Status">${status(runner.online ? "online" : "offline")}</td><td data-label="Tags">${esc((runner.tags || []).join(", "))}</td><td data-label="Last heartbeat">${esc(runner.lastHeartbeatAt || "never")}</td></tr>`).join("")}
    </tbody></table>` : empty("No runners connected.", "Start one with <code>smithers-hub-runner</code> using a token that has the runner scope.")}
  </section>`;
  bindCopy();
}

// --- Agents area folds Agents + Skills + Knowledge into one tabbed view ----
const AGENT_TABS = [
  { key: "agents", label: "Agents", endpoint: "agents", blurb: "Personas that combine skills + knowledge to handle workflows.", link: (slug) => deepLinks.agent(slug) },
  { key: "skills", label: "Skills", endpoint: "skills", blurb: "Reusable capabilities your agents can call on.", link: (slug) => deepLinks.skill(slug) },
  { key: "knowledge", label: "Knowledge", endpoint: "knowledge", blurb: "Documents and references agents draw from.", link: (slug) => deepLinks.knowledgeItem(slug) }
];

async function renderAgents(tab = "agents") {
  const meta = AGENT_TABS.find((t) => t.key === tab) || AGENT_TABS[0];
  const data = await api(`/api/${meta.endpoint}`);
  const items = data[meta.endpoint === "knowledge" ? "knowledge" : meta.endpoint] || [];
  // Best-effort fan-out: pull capabilities so we can show which workflows
  // reference each agent/skill — cheap relationship hint, no schema change.
  let capabilities = [];
  if (meta.key !== "knowledge") {
    try {
      capabilities = (await api("/api/capabilities")).capabilities || [];
    } catch {
      // non-fatal
    }
  }
  const tabsHtml = AGENT_TABS.map((t) => `<button type="button" class="tab ${t.key === meta.key ? "active" : ""}" data-tab="${esc(t.key)}">${esc(t.label)}</button>`).join("");
  const singular = meta.label.replace(/s$/, "");
  const sectionHash = `#agents/${meta.key}`;
  content.innerHTML = `${toolbar("Agents", `<button id="new-item">New ${esc(singular === "Knowledge" ? "entry" : singular)}</button>`, sectionHash)}
    <nav class="tabs">${tabsHtml}</nav>
    <p class="muted agents-blurb">${esc(meta.blurb)}</p>
    ${items.length ? `<div class="grid">${items.map((item) => renderAgentCard(meta, item, capabilities)).join("")}</div>` : empty(`No ${meta.label.toLowerCase()} yet.`)}
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll(".tabs [data-tab]").forEach((button) => button.addEventListener("click", () => setView(`agents/${button.dataset.tab}`)));
  $("#new-item").addEventListener("click", () => editItem(meta.endpoint));
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => editItem(meta.endpoint, button.dataset.edit)));
  bindCopy();
}

// Rich card per agent/skill/knowledge item: description, pills for related
// content (skills, tools, tags), cheap "Used by" backlinks to workflows that
// require the agent or skill, plus a stable deep link / Edit affordance.
function renderAgentCard(meta, item, capabilities) {
  const name = item.name || item.title || item.slug;
  const desc = item.description || item.body || "";
  const skillSlugs = item.skillSlugs || item.skill_slugs || [];
  const tags = item.tags || [];
  const tools = item.tools || [];
  const related = [];
  if (meta.key === "agents") {
    for (const cap of capabilities || []) if ((cap.requiredAgents || []).includes(item.slug)) related.push(cap);
  } else if (meta.key === "skills") {
    for (const cap of capabilities || []) if ((cap.requiredSkills || []).includes(item.slug)) related.push(cap);
  }
  const url = item.url ? `<p class="muted"><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.url)}</a></p>` : "";
  return `<article class="item agent-card" id="${esc(meta.key)}-${esc(item.slug)}">
    <h3><a href="${esc(meta.link(item.slug))}">${esc(name)}</a> ${shareButton(meta.link(item.slug), `Copy share link to ${name}`)}</h3>
    <p class="muted agent-desc">${esc(desc)}</p>
    ${url}
    ${skillSlugs.length ? `<div class="pill-row"><span class="pill-label">Skills</span>${pills(skillSlugs, { link: (s) => deepLinks.skill(s) })}</div>` : ""}
    ${tools.length ? `<div class="pill-row"><span class="pill-label">Tools</span>${pills(tools, { kind: "pill tag" })}</div>` : ""}
    ${tags.length ? `<div class="pill-row"><span class="pill-label">Tags</span>${pills(tags, { kind: "pill tag" })}</div>` : ""}
    ${related.length ? `<div class="pill-row"><span class="pill-label">Used by</span>${pills(related.map((c) => ({ label: c.name, href: deepLinks.workflow(c.slug) })))}</div>` : ""}
    <div class="toolbar-actions">
      <a class="button" href="${esc(meta.link(item.slug))}">Open</a>
      <button data-edit="${esc(item.slug)}">Edit</button>
    </div>
  </article>`;
}

async function editItem(kind, slug = "") {
  const collection = (await api(`/api/${kind}`))[kind === "knowledge" ? "knowledge" : kind];
  const item = slug ? collection.find((entry) => entry.slug === slug) : { slug: "", name: "", title: "", description: "", body: "", instructions: "" };
  if (!item) return; // deep-linked slug that no longer exists
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const tabKey = kind === "knowledge" ? "knowledge" : kind === "skills" ? "skills" : "agents";
  const itemHash = `#agents/${tabKey}/${encodeURIComponent(slug || item.slug || "")}`;
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"} ${slug ? shareButton(itemHash, "Copy share link to this item") : ""}</h2>
    <form id="item-form" class="form-grid">
      <label>JSON<textarea id="item-json">${esc(JSON.stringify(item, null, 2))}</textarea></label>
      <button class="primary" type="submit">Save</button>
    </form>`;
  bindCopy();
  $("#item-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let payload;
    try {
      payload = JSON.parse($("#item-json").value);
    } catch {
      return toast("JSON is invalid", "error");
    }
    try {
      await api(slug ? `/api/${kind}/${slug}` : `/api/${kind}`, { method: slug ? "PATCH" : "POST", body: payload });
      toast("Saved", "ok");
      await renderAgents(kind === "knowledge" ? "knowledge" : kind === "skills" ? "skills" : "agents");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

const TOKEN_SCOPES = ["api", "mcp", "runner", "admin"];

async function renderTokens() {
  const data = await api("/api/tokens");
  content.innerHTML = `${toolbar("Access Tokens", "", deepLinks.tokens())}
    <section class="split">
      <div class="panel">
        <h2>Create Token</h2>
        <form id="token-form" class="form-grid">
          <label>Name<input id="token-name" value="local agent"></label>
          <label>Scopes
            <div class="toolbar-actions">
              ${TOKEN_SCOPES.map((scope) => `<label class="muted"><input type="checkbox" class="token-scope" value="${scope}" ${scope === "api" || scope === "mcp" ? "checked" : ""}> ${scope}</label>`).join("")}
            </div>
          </label>
          <label>Expires in days (0 = never)<input id="token-expiry" type="number" min="0" value="0"></label>
          <button class="primary" type="submit">Create Token</button>
        </form>
        <div id="created-token"></div>
      </div>
      <div class="panel">
        <h2>Existing Tokens</h2>
        ${tokenTable(data.tokens)}
      </div>
    </section>`;
  $("#token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const scopes = Array.from(document.querySelectorAll(".token-scope:checked")).map((el) => el.value);
    const expiresInDays = Number($("#token-expiry").value || 0);
    const created = await api("/api/tokens", { method: "POST", body: { name: $("#token-name").value, scopes, expiresInDays } });
    $("#created-token").innerHTML = `<h3>Token created</h3><p class="muted">This value is shown once. Copy it now.</p>
      <div class="copy-row"><input id="token-value" readonly value="${esc(created.token.token)}"><button type="button" id="copy-token">Copy</button></div>`;
    $("#copy-token").addEventListener("click", async () => {
      const value = $("#token-value").value;
      try {
        await navigator.clipboard.writeText(value);
        toast("Token copied", "ok");
      } catch {
        $("#token-value").select();
        toast("Press Ctrl/Cmd+C to copy", "info");
      }
    });
    toast("Token created", "ok");
    await refreshTokenTable();
  });
  bindRevoke();
  bindCopy();
}

function tokenTable(tokens) {
  if (!tokens.length) return `<p class="muted">No tokens.</p>`;
  return `<table class="table"><thead><tr><th>Name</th><th>Scopes</th><th>State</th><th></th></tr></thead><tbody>
    ${tokens.map((token) => `<tr>
      <td data-label="Name">${esc(token.name)}<br><span class="muted">${esc(token.id)}</span></td>
      <td data-label="Scopes">${esc((token.scopes || []).join(", "))}</td>
      <td data-label="State">${status(token.active ? "online" : "offline")}${token.expiresAt ? `<br><span class="muted">expires ${esc(token.expiresAt)}</span>` : ""}</td>
      <td data-label="Action">${token.active ? `<button class="danger" data-revoke="${esc(token.id)}">Revoke</button>` : "<span class=\"muted\">revoked</span>"}</td>
    </tr>`).join("")}
  </tbody></table>`;
}

async function refreshTokenTable() {
  const data = await api("/api/tokens");
  const panels = document.querySelectorAll(".panel");
  if (panels[1]) panels[1].innerHTML = `<h2>Existing Tokens</h2>${tokenTable(data.tokens)}`;
  bindRevoke();
}

function bindRevoke() {
  document.querySelectorAll("[data-revoke]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Revoke this token? It will stop working immediately.")) return;
      try {
        await api(`/api/tokens/${button.dataset.revoke}`, { method: "DELETE" });
      } catch (error) {
        alert(error.message);
      }
      await refreshTokenTable();
    })
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", "ok");
  } catch {
    toast("Copy failed — select the text and press Ctrl/Cmd+C", "info");
  }
}

function bindCopy() {
  document.querySelectorAll("[data-copy]").forEach((b) => {
    if (b.dataset.copyBound === "1") return;
    b.dataset.copyBound = "1";
    b.addEventListener("click", (event) => {
      event.preventDefault();
      copyText(b.dataset.copy);
    });
  });
  document.querySelectorAll("[data-copy-el]").forEach((b) => {
    if (b.dataset.copyBound === "1") return;
    b.dataset.copyBound = "1";
    b.addEventListener("click", () => copyText(document.getElementById(b.dataset.copyEl).value));
  });
}

async function renderConnect() {
  const origin = location.origin;
  const installCmd = `bash <(curl -fsSL ${origin}/install.sh)`;
  content.innerHTML = `${toolbar("Connect an Agent or Teammate", "", deepLinks.connect())}
    <section class="split">
      <div class="panel">
        <h2>1 · Install the client</h2>
        <p class="muted">One command — installs the <code>smithers-hub</code> CLI + MCP server and asks you to paste a token. Requires Node.js 18+.</p>
        <div class="copy-row"><input readonly value="${esc(installCmd)}"><button data-copy="${esc(installCmd)}">Copy</button></div>
        <h3>2 · Connect every AI agent</h3>
        <p class="muted">Auto-detects and configures the AI clients on your machine — no JSON editing:</p>
        <div class="copy-row"><input readonly value="smithers-hub mcp install --all"><button data-copy="smithers-hub mcp install --all">Copy</button></div>
        <p class="muted">Supports Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code. Target one with <code>--client &lt;name&gt;</code>.</p>
        <h3>Multiple orgs?</h3>
        <p class="muted">Each org is its own hub. On the same machine: <code>smithers-hub login --remote &lt;org&gt;</code> (against that org's URL), then <code>smithers-hub mcp install --all --remote &lt;org&gt;</code> — its tools install alongside, namespaced <code>smithers-hub-&lt;org&gt;</code>.</p>
      </div>
      <div class="panel">
        <h2>Onboard a teammate</h2>
        <p class="muted">Generate a token to hand them. They run the install command above and paste this when asked — no secret baked into any command.</p>
        <form id="invite-form" class="form-grid">
          <label>Scopes
            <div class="toolbar-actions">
              ${["api", "mcp", "runner", "admin"].map((s) => `<label class="muted"><input type="checkbox" class="invite-scope" value="${s}" ${s === "api" || s === "mcp" ? "checked" : ""}> ${s}</label>`).join("")}
            </div>
          </label>
          <label>Label<input id="invite-name" value="teammate"></label>
          <button class="primary" type="submit">Generate token</button>
        </form>
        <div id="invite-out"></div>
        <h3>Shareable deep links</h3>
        <p class="muted">Every page, run, workflow, and artifact has a stable URL. Click any 🔗 in the console to copy one — paste into chat or docs.</p>
      </div>
    </section>`;
  bindCopy();
  $("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const scopes = Array.from(document.querySelectorAll(".invite-scope:checked")).map((el) => el.value);
    if (!scopes.length) return toast("Pick at least one scope", "error");
    try {
      const data = await api("/api/tokens", { method: "POST", body: { name: $("#invite-name").value || "teammate", scopes } });
      $("#invite-out").innerHTML = `<h3>Send these to your teammate</h3>
        <p class="muted">Token (shown once) — they paste it when the installer asks:</p>
        <div class="copy-row"><input id="invite-token" readonly value="${esc(data.token.token)}"><button data-copy-el="invite-token">Copy</button></div>
        <p class="muted">Install command:</p>
        <div class="copy-row"><input id="invite-cmd" readonly value="${esc(installCmd)}"><button data-copy-el="invite-cmd">Copy</button></div>
        <p class="muted">Then they run <code>smithers-hub mcp install --all</code>. Revoke anytime under Tokens.</p>`;
      bindCopy();
      toast("Token generated", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function renderAudit() {
  let data;
  try {
    data = await api("/api/audit");
  } catch (error) {
    content.innerHTML = `${toolbar("Audit Log", "", deepLinks.audit())}<section class="panel"><p class="muted">${esc(error.message)} (admin scope required)</p></section>`;
    return;
  }
  const rows = data.audit;
  content.innerHTML = `${toolbar("Audit Log", "", deepLinks.audit())}<section class="panel">
    ${rows.length ? `<table class="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>
      ${rows.map((entry) => `<tr><td data-label="Time">${esc(entry.createdAt)}</td><td data-label="Actor">${esc(entry.actor)}</td><td data-label="Action">${esc(entry.action)}</td><td data-label="Target"><span class="muted">${esc(entry.target || "")}</span></td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">No audit entries yet.</p>`}
  </section>`;
  bindCopy();
}

async function renderSettings() {
  const setup = await api("/api/setup");
  content.innerHTML = `${toolbar("Settings", "", deepLinks.settings())}
    <section class="split">
      <div class="panel">
        <h2>Deployment</h2>
        ${json(setup)}
      </div>
      <div class="panel">
        <h2>Telegram Approvals</h2>
        <p>${status(setup.telegramConfigured ? "online" : "pending")}</p>
        <p class="muted">Set <code>TELEGRAM_BOT_TOKEN</code> and preferred private DM target <code>TELEGRAM_APPROVAL_CHAT_ID</code>. Legacy <code>TELEGRAM_CHAT_ID</code>/<code>TELEGRAM_THREAD_ID</code> remains a fallback for non-approval chat routing. Web, API, CLI, and MCP approvals work without Telegram.</p>
      </div>
    </section>`;
  bindCopy();
}

// React to back/forward and to plain anchor clicks (`<a href="#runs/abc">`),
// so deep-linked URLs survive reload and update on every navigation.
window.addEventListener("hashchange", () => {
  state.view = location.hash.slice(1) || "home";
  render().catch(showError);
});

boot();
