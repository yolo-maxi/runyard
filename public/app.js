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

function toolbar(title, actions = "") {
  return `<div class="toolbar"><h1>${esc(title)}</h1><div class="toolbar-actions">${actions}</div></div>`;
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
  const raw = state.view || "home";
  const view = raw.split("/")[0];
  highlightSidebar(view);
  if (raw.startsWith("runs/")) return renderRunDetail(raw.split("/")[1]);
  if (view === "home" || view === "runs" || view === "dashboard") return renderHome();
  if (view === "workflows" || view === "capabilities") {
    const slug = raw.split("/")[1];
    await renderCapabilities();
    if (slug) await showRunForm(slug);
    return;
  }
  if (view === "agents" || view === "skills" || view === "knowledge") {
    // Allow #agents/<tab>, plus legacy #skills / #knowledge hashes.
    const tab = raw.startsWith("agents/") ? raw.split("/")[1] : (view === "agents" ? "agents" : view);
    return renderAgents(tab);
  }
  if (view === "connect") return renderConnect();
  if (view === "approvals") return renderApprovals();
  if (view === "artifacts") return renderArtifacts();
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

function runCard(run, artifacts = []) {
  const active = isActiveRun(run);
  const folder = runFolderLabel(run);
  const slug = esc(run.capabilitySlug || "");
  const artifactPreview = !active && artifacts.length
    ? `<ul class="artifact-list">
        ${artifacts.slice(0, 3).map((a) => `<li><a href="/api/artifacts/${esc(a.id)}/download" target="_blank">${esc(artifactDisplayName(a))}</a> <span class="muted">${esc(formatBytes(a.sizeBytes))}</span></li>`).join("")}
        ${artifacts.length > 3 ? `<li class="muted">+${artifacts.length - 3} more</li>` : ""}
      </ul>`
    : "";
  return `<article class="run-card ${active ? "active" : "done"} ${esc(run.status)}">
    <header class="run-card-head">
      ${active ? '<span class="run-pulse" aria-hidden="true"></span>' : '<span class="run-folder-icon" aria-hidden="true">📁</span>'}
      ${status(run.status)}
      <span class="run-folder" title="Display-only grouping">${esc(folder)}</span>
    </header>
    <h3 class="run-card-title"><a href="#runs/${esc(run.id)}">${esc(run.capabilityName)}</a></h3>
    <p class="muted run-step">${esc(run.currentStep || (active ? "starting…" : run.createdAt))}</p>
    ${artifactPreview}
    <footer class="run-card-foot">
      <a class="button" href="#workflows${slug ? `/${slug}` : ""}">Workflow</a>
      <a class="button" href="#runs/${esc(run.id)}">Run log</a>
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
  content.innerHTML = `${toolbar("Runs", `<button id="home-new-run">Run a workflow</button>`)}
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
      : `<p class="muted run-empty">No active runs right now. Start one from <a href="#workflows">Workflows</a>.</p>`}
    <h2 class="section-heading">Recent &amp; completed</h2>
    ${completed.length
      ? `<section class="run-grid">${completed.slice(0, 30).map((run) => runCard(run, artifactsByRun.get(run.id) || [])).join("")}</section>`
      : `<p class="muted">Completed runs and their artifacts will appear here.</p>`}
    ${pending.length ? `<h2 class="section-heading">Pending approvals</h2>
      <section class="panel">${approvalList(pending)}</section>` : ""}`;
  $("#home-new-run").addEventListener("click", () => setView("workflows"));
  document.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.approve, "approve").then(() => render().catch(showError))));
  document.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.reject, "reject").then(() => render().catch(showError))));
}

function runsTable(runs) {
  if (!runs.length) return `<p class="muted">No runs yet.</p>`;
  return `<table class="table"><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Step</th><th>Created</th></tr></thead><tbody>
    ${runs.map((run) => `<tr><td data-label="Run"><a href="#runs/${run.id}" data-run="${run.id}">${esc(run.id)}</a></td><td data-label="Workflow">${esc(run.capabilityName)}</td><td data-label="Status">${status(run.status)}</td><td data-label="Step">${esc(run.currentStep)}</td><td data-label="Created">${esc(run.createdAt)}</td></tr>`).join("")}
  </tbody></table>`;
}

async function renderCapabilities() {
  const data = await api("/api/capabilities");
  content.innerHTML = `${toolbar("Workflows", `<button id="new-cap">New Workflow</button>`)}
    <p class="muted">A workflow is a capability your agents can invoke. They appear as MCP tools and as launchable buttons here.</p>
    ${data.capabilities.length ? `<div class="grid">
      ${data.capabilities.map((cap) => `<article class="item">
        <h3>${esc(cap.name)}</h3>
        <p class="muted">${esc(cap.description)}</p>
        <p>${esc(cap.category)} · v${cap.version} · ${cap.enabled ? "enabled" : "disabled"}${cap.approvalPolicy?.required ? " · needs approval" : ""}</p>
        <div class="toolbar-actions">
          <button data-run="${esc(cap.slug)}" class="primary">Run</button>
          <button data-edit-cap="${esc(cap.slug)}">Edit</button>
        </div>
      </article>`).join("")}
    </div>` : empty("No workflows yet.", "Click New Workflow to define the first action agents can run.")}
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => showRunForm(button.dataset.run)));
  document.querySelectorAll("[data-edit-cap]").forEach((button) => button.addEventListener("click", () => editCapability(button.dataset.editCap)));
  $("#new-cap").addEventListener("click", () => editCapability());
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
  editor.innerHTML = `<h2>Run ${esc(cap.name)}</h2>
    <p class="muted">${esc(cap.description || "")}</p>
    ${approval ? `<p class="notice">This workflow requires approval before it runs.${cap.approvalPolicy?.reason ? ` ${esc(cap.approvalPolicy.reason)}` : ""}</p>` : ""}
    <form id="run-form" class="form-grid">
      ${hasFields ? schemaForm(schema) : `<label>Input JSON<textarea data-field="__raw" data-ftype="json" placeholder="{}">{}</textarea><span class="field-hint">This workflow has no declared input schema. Provide raw JSON.</span><span class="field-error" data-error-for="__raw"></span></label>`}
      ${hasFields ? `<details class="advanced"><summary>Edit as raw JSON instead</summary><label><textarea id="run-raw" data-ftype="json" placeholder="{}">${esc(JSON.stringify(sample, null, 2))}</textarea></label></details>` : ""}
      <button class="primary" type="submit">Create Run</button>
    </form>
    <details class="advanced"><summary>Workflow contract</summary>${json(cap)}</details>`;
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
      location.hash = `runs/${result.run.id}`;
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
      if (slug) await api(`/api/capabilities/${slug}`, { method: "PATCH", body: payload });
      else await api("/api/capabilities", { method: "POST", body: payload });
      toast("Workflow saved", "ok");
      await renderCapabilities();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function renderRunDetail(runId) {
  const data = await api(`/api/runs/${runId}`);
  const run = data.run;
  const folder = runFolderLabel(run);
  const slug = esc(run.capabilitySlug || "");
  content.innerHTML = `${toolbar(run.id, `<a class="button" href="#workflows${slug ? `/${slug}` : ""}">Workflow</a><button id="cancel-run" class="danger">Cancel</button>`)}
    <p class="run-folder-banner"><span class="run-folder">📁 ${esc(folder)}</span> <span class="muted">— display-only grouping for this run's artifacts &amp; logs</span></p>
    <section class="split">
      <div class="panel">
        <h2>${esc(run.capabilityName)} ${status(run.status)}</h2>
        <p class="muted">${esc(run.currentStep)}</p>
        <h3>Timeline</h3>
        <div class="timeline">${data.events.map((event) => `<div class="event"><time>${esc(event.createdAt)}</time><strong>${esc(event.type)}</strong><br>${esc(event.message)}</div>`).join("")}</div>
      </div>
      <div class="panel">
        <h3>Input</h3>${json(run.input)}
        <h3>Output</h3>${json(run.output)}
        <h3>Artifacts</h3>
        ${artifactList(data.artifacts)}
      </div>
    </section>`;
  $("#cancel-run").addEventListener("click", async () => {
    await api(`/api/runs/${run.id}/cancel`, { method: "POST", body: { reason: "Cancelled from Web Hub" } });
    await renderRunDetail(run.id);
  });
}

function artifactList(artifacts) {
  if (!artifacts.length) return `<p class="muted">No artifacts.</p>`;
  return `<ul class="artifact-list">${artifacts.map((artifact) => `<li><a href="/api/artifacts/${artifact.id}/download" target="_blank">${esc(artifactDisplayName(artifact))}</a> <span class="muted">${esc(formatBytes(artifact.sizeBytes))}${artifact.mimeType ? ` · ${esc(artifact.mimeType)}` : ""}</span></li>`).join("")}</ul>`;
}

function approvalList(approvals) {
  if (!approvals.length) return `<p class="muted">No pending approvals.</p>`;
  return `<div class="timeline">${approvals.map((approval) => `<div class="event">
    <strong>${esc(approval.title)}</strong><br>
    <span class="muted">${esc(approval.description)}</span><br>
    ${status(approval.status)}
    <div class="toolbar-actions">
      <button data-approve="${esc(approval.id)}" class="primary">Approve</button>
      <button data-reject="${esc(approval.id)}" class="danger">Reject</button>
    </div>
  </div>`).join("")}</div>`;
}

async function renderApprovals() {
  const data = await api("/api/approvals");
  content.innerHTML = `${toolbar("Approvals")}<section class="panel">${approvalList(data.approvals)}</section>`;
  document.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.approve, "approve")));
  document.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => resolveApproval(button.dataset.reject, "reject")));
}

async function resolveApproval(id, decision) {
  await api(`/api/approvals/${id}/${decision}`, { method: "POST", body: { comment: `Resolved from Web Hub` } });
  await renderApprovals();
}

async function renderArtifacts() {
  const data = await api("/api/artifacts");
  content.innerHTML = `${toolbar("Artifacts")}<section class="panel">${artifactList(data.artifacts)}</section>`;
}

async function renderRunners() {
  const data = await api("/api/runners");
  content.innerHTML = `${toolbar("Runners")}<section class="panel">
    ${data.runners.length ? `<table class="table"><thead><tr><th>Name</th><th>Status</th><th>Tags</th><th>Last heartbeat</th></tr></thead><tbody>
      ${data.runners.map((runner) => `<tr><td data-label="Name">${esc(runner.name)}<br><span class="muted">${esc(runner.id)}</span></td><td data-label="Status">${status(runner.online ? "online" : "offline")}</td><td data-label="Tags">${esc((runner.tags || []).join(", "))}</td><td data-label="Last heartbeat">${esc(runner.lastHeartbeatAt || "never")}</td></tr>`).join("")}
    </tbody></table>` : empty("No runners connected.", "Start one with <code>smithers-hub-runner</code> using a token that has the runner scope.")}
  </section>`;
}

// --- Agents area folds Agents + Skills + Knowledge into one tabbed view ----
const AGENT_TABS = [
  { key: "agents", label: "Agents", endpoint: "agents", blurb: "Personas that combine skills + knowledge to handle workflows." },
  { key: "skills", label: "Skills", endpoint: "skills", blurb: "Reusable capabilities your agents can call on." },
  { key: "knowledge", label: "Knowledge", endpoint: "knowledge", blurb: "Documents and references agents draw from." }
];

async function renderAgents(tab = "agents") {
  const meta = AGENT_TABS.find((t) => t.key === tab) || AGENT_TABS[0];
  const data = await api(`/api/${meta.endpoint}`);
  const items = data[meta.endpoint === "knowledge" ? "knowledge" : meta.endpoint] || [];
  const tabsHtml = AGENT_TABS.map((t) => `<button type="button" class="tab ${t.key === meta.key ? "active" : ""}" data-tab="${esc(t.key)}">${esc(t.label)}</button>`).join("");
  const singular = meta.label.replace(/s$/, "");
  content.innerHTML = `${toolbar("Agents", `<button id="new-item">New ${esc(singular === "Knowledge" ? "entry" : singular)}</button>`)}
    <nav class="tabs">${tabsHtml}</nav>
    <p class="muted agents-blurb">${esc(meta.blurb)}</p>
    ${items.length ? `<div class="grid">${items.map((item) => `<article class="item">
      <h3>${esc(item.name || item.title)}</h3>
      <p class="muted">${esc(item.description || item.body || "")}</p>
      <button data-edit="${esc(item.slug)}">Edit</button>
    </article>`).join("")}</div>` : empty(`No ${meta.label.toLowerCase()} yet.`)}
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll(".tabs [data-tab]").forEach((button) => button.addEventListener("click", () => setView(`agents/${button.dataset.tab}`)));
  $("#new-item").addEventListener("click", () => editItem(meta.endpoint));
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => editItem(meta.endpoint, button.dataset.edit)));
}

async function editItem(kind, slug = "") {
  const collection = (await api(`/api/${kind}`))[kind === "knowledge" ? "knowledge" : kind];
  const item = slug ? collection.find((entry) => entry.slug === slug) : { slug: "", name: "", title: "", description: "", body: "", instructions: "" };
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"}</h2>
    <form id="item-form" class="form-grid">
      <label>JSON<textarea id="item-json">${esc(JSON.stringify(item, null, 2))}</textarea></label>
      <button class="primary" type="submit">Save</button>
    </form>`;
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
      await renderAgents(kind);
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

const TOKEN_SCOPES = ["api", "mcp", "runner", "admin"];

async function renderTokens() {
  const data = await api("/api/tokens");
  content.innerHTML = `${toolbar("Access Tokens")}
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
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copyText(b.dataset.copy)));
  document.querySelectorAll("[data-copy-el]").forEach((b) =>
    b.addEventListener("click", () => copyText(document.getElementById(b.dataset.copyEl).value))
  );
}

async function renderConnect() {
  const origin = location.origin;
  const installCmd = `bash <(curl -fsSL ${origin}/install.sh)`;
  content.innerHTML = `${toolbar("Connect an Agent or Teammate")}
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
    content.innerHTML = `${toolbar("Audit Log")}<section class="panel"><p class="muted">${esc(error.message)} (admin scope required)</p></section>`;
    return;
  }
  const rows = data.audit;
  content.innerHTML = `${toolbar("Audit Log")}<section class="panel">
    ${rows.length ? `<table class="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>
      ${rows.map((entry) => `<tr><td data-label="Time">${esc(entry.createdAt)}</td><td data-label="Actor">${esc(entry.actor)}</td><td data-label="Action">${esc(entry.action)}</td><td data-label="Target"><span class="muted">${esc(entry.target || "")}</span></td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">No audit entries yet.</p>`}
  </section>`;
}

async function renderSettings() {
  const setup = await api("/api/setup");
  content.innerHTML = `${toolbar("Settings")}
    <section class="split">
      <div class="panel">
        <h2>Deployment</h2>
        ${json(setup)}
      </div>
      <div class="panel">
        <h2>Telegram Approvals</h2>
        <p>${status(setup.telegramConfigured ? "online" : "pending")}</p>
        <p class="muted">Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in the service environment to send approval requests to Telegram. Web, API, CLI, and MCP approvals work without Telegram.</p>
      </div>
    </section>`;
}

window.addEventListener("hashchange", () => {
  state.view = location.hash.slice(1) || "home";
  render().catch(showError);
});

boot();
