const state = {
  me: null,
  view: "dashboard"
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

function setView(view) {
  state.view = view;
  document.querySelectorAll(".sidebar button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
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
    state.view = location.hash.slice(1) || "dashboard";
    document.querySelectorAll(".sidebar button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
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
  const view = state.view.split("/")[0];
  document.querySelectorAll(".sidebar button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (state.view.startsWith("runs/")) return renderRunDetail(state.view.split("/")[1]);
  if (view === "dashboard") return renderDashboard();
  if (view === "connect") return renderConnect();
  if (view === "capabilities") return renderCapabilities();
  if (view === "runs") return renderRuns();
  if (view === "approvals") return renderApprovals();
  if (view === "artifacts") return renderArtifacts();
  if (view === "runners") return renderRunners();
  if (view === "agents") return renderEditableList("agents", "Agents");
  if (view === "skills") return renderEditableList("skills", "Skills");
  if (view === "knowledge") return renderEditableList("knowledge", "Knowledge");
  if (view === "tokens") return renderTokens();
  if (view === "audit") return renderAudit();
  if (view === "settings") return renderSettings();
  return renderDashboard();
}

async function renderDashboard() {
  const data = await api("/api/dashboard");
  const stats = data.stats;
  const gettingStarted = (stats.runs || 0) === 0;
  content.innerHTML = `${toolbar("Operations Dashboard", `<button id="dash-run-cap">Run Capability</button>`)}
    ${gettingStarted ? empty("Welcome to Smithers Hub.", "Pick a capability and run it, start a runner to execute work, or create scoped tokens for your agents. Start by opening the Capabilities tab.") : ""}
    <section class="stats">
      ${Object.entries({
        Capabilities: stats.capabilities,
        Runs: stats.runs,
        "Active Runs": stats.runningRuns,
        Artifacts: stats.artifacts,
        Runners: stats.runners,
        "Pending Approvals": stats.pendingApprovals
      }).map(([label, value]) => `<div class="stat"><strong>${value}</strong><span class="muted">${label}</span></div>`).join("")}
    </section>
    <section class="split">
      <div class="panel">
        <h2>Recent Runs</h2>
        ${runsTable(data.recentRuns)}
      </div>
      <div class="panel">
        <h2>Pending Approvals</h2>
        ${approvalList(data.pendingApprovals)}
      </div>
    </section>`;
  $("#dash-run-cap").addEventListener("click", () => setView("capabilities"));
}

function runsTable(runs) {
  if (!runs.length) return `<p class="muted">No runs yet.</p>`;
  return `<table class="table"><thead><tr><th>Run</th><th>Capability</th><th>Status</th><th>Step</th><th>Created</th></tr></thead><tbody>
    ${runs.map((run) => `<tr><td><a href="#runs/${run.id}" data-run="${run.id}">${esc(run.id)}</a></td><td>${esc(run.capabilityName)}</td><td>${status(run.status)}</td><td>${esc(run.currentStep)}</td><td>${esc(run.createdAt)}</td></tr>`).join("")}
  </tbody></table>`;
}

async function renderCapabilities() {
  const data = await api("/api/capabilities");
  content.innerHTML = `${toolbar("Capability Catalog", `<button id="new-cap">New Capability</button>`)}
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
    </div>` : empty("No capabilities yet.", "Click New Capability to define the first action agents can run.")}
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
    ${approval ? `<p class="notice">This capability requires approval before it runs.${cap.approvalPolicy?.reason ? ` ${esc(cap.approvalPolicy.reason)}` : ""}</p>` : ""}
    <form id="run-form" class="form-grid">
      ${hasFields ? schemaForm(schema) : `<label>Input JSON<textarea data-field="__raw" data-ftype="json" placeholder="{}">{}</textarea><span class="field-hint">This capability has no declared input schema. Provide raw JSON.</span><span class="field-error" data-error-for="__raw"></span></label>`}
      ${hasFields ? `<details class="advanced"><summary>Edit as raw JSON instead</summary><label><textarea id="run-raw" data-ftype="json" placeholder="{}">${esc(JSON.stringify(sample, null, 2))}</textarea></label></details>` : ""}
      <button class="primary" type="submit">Create Run</button>
    </form>
    <details class="advanced"><summary>Capability contract</summary>${json(cap)}</details>`;
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
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"} Capability</h2>
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
      <button class="primary" type="submit">Save Capability</button>
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
      toast("Capability saved", "ok");
      await renderCapabilities();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function renderRuns() {
  const data = await api("/api/runs");
  content.innerHTML = `${toolbar("Runs")}<section class="panel">${runsTable(data.runs)}</section>`;
}

async function renderRunDetail(runId) {
  const data = await api(`/api/runs/${runId}`);
  const run = data.run;
  content.innerHTML = `${toolbar(run.id, `<button id="cancel-run" class="danger">Cancel</button>`)}
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
  return `<ul>${artifacts.map((artifact) => `<li><a href="/api/artifacts/${artifact.id}/download" target="_blank">${esc(artifact.name)}</a> <span class="muted">${artifact.sizeBytes} bytes</span></li>`).join("")}</ul>`;
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
      ${data.runners.map((runner) => `<tr><td>${esc(runner.name)}<br><span class="muted">${esc(runner.id)}</span></td><td>${status(runner.online ? "online" : "offline")}</td><td>${esc((runner.tags || []).join(", "))}</td><td>${esc(runner.lastHeartbeatAt || "never")}</td></tr>`).join("")}
    </tbody></table>` : empty("No runners connected.", "Start one with <code>smithers-hub-runner</code> using a token that has the runner scope.")}
  </section>`;
}

async function renderEditableList(kind, title) {
  const data = await api(`/api/${kind}`);
  const key = kind === "knowledge" ? "knowledge" : kind;
  const items = data[key];
  content.innerHTML = `${toolbar(title, `<button id="new-item">New</button>`)}
    <div class="grid">${items.map((item) => `<article class="item">
      <h3>${esc(item.name || item.title)}</h3>
      <p class="muted">${esc(item.description || item.body || "")}</p>
      <button data-edit="${esc(item.slug)}">Edit</button>
    </article>`).join("")}</div>
    <section id="editor" class="panel hidden"></section>`;
  $("#new-item").addEventListener("click", () => editItem(kind));
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => editItem(kind, button.dataset.edit)));
}

async function editItem(kind, slug = "") {
  const collection = (await api(`/api/${kind}`))[kind === "knowledge" ? "knowledge" : kind];
  const item = slug ? collection.find((entry) => entry.slug === slug) : { slug: "", name: "", title: "", description: "", body: "", instructions: "" };
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"}</h2>
    <form id="item-form" class="form-grid">
      <label>JSON<textarea id="item-json">${esc(JSON.stringify(item, null, 2))}</textarea></label>
      <button class="primary" type="submit">Save</button>
    </form>`;
  $("#item-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = JSON.parse($("#item-json").value);
    await api(slug ? `/api/${kind}/${slug}` : `/api/${kind}`, { method: slug ? "PATCH" : "POST", body: payload });
    await renderEditableList(kind, kind[0].toUpperCase() + kind.slice(1));
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
      <td>${esc(token.name)}<br><span class="muted">${esc(token.id)}</span></td>
      <td>${esc((token.scopes || []).join(", "))}</td>
      <td>${status(token.active ? "online" : "offline")}${token.expiresAt ? `<br><span class="muted">expires ${esc(token.expiresAt)}</span>` : ""}</td>
      <td>${token.active ? `<button class="danger" data-revoke="${esc(token.id)}">Revoke</button>` : "<span class=\"muted\">revoked</span>"}</td>
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
      ${rows.map((entry) => `<tr><td>${esc(entry.createdAt)}</td><td>${esc(entry.actor)}</td><td>${esc(entry.action)}</td><td><span class="muted">${esc(entry.target || "")}</span></td></tr>`).join("")}
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
  state.view = location.hash.slice(1) || "dashboard";
  render().catch(showError);
});

boot();
