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
    alert(error.message);
  }
});

async function render() {
  const view = state.view.split("/")[0];
  document.querySelectorAll(".sidebar button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (state.view.startsWith("runs/")) return renderRunDetail(state.view.split("/")[1]);
  if (view === "dashboard") return renderDashboard();
  if (view === "capabilities") return renderCapabilities();
  if (view === "runs") return renderRuns();
  if (view === "approvals") return renderApprovals();
  if (view === "artifacts") return renderArtifacts();
  if (view === "runners") return renderRunners();
  if (view === "agents") return renderEditableList("agents", "Agents");
  if (view === "skills") return renderEditableList("skills", "Skills");
  if (view === "knowledge") return renderEditableList("knowledge", "Knowledge");
  if (view === "tokens") return renderTokens();
  if (view === "settings") return renderSettings();
  return renderDashboard();
}

async function renderDashboard() {
  const data = await api("/api/dashboard");
  const stats = data.stats;
  content.innerHTML = `${toolbar("Operations Dashboard", `<button onclick="location.hash='capabilities'; location.reload()">Run Capability</button>`)}
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
    <div class="grid">
      ${data.capabilities.map((cap) => `<article class="item">
        <h3>${esc(cap.name)}</h3>
        <p class="muted">${esc(cap.description)}</p>
        <p>${esc(cap.category)} · v${cap.version} · ${cap.enabled ? "enabled" : "disabled"}</p>
        <div class="toolbar-actions">
          <button data-run="${esc(cap.slug)}" class="primary">Run</button>
          <button data-edit-cap="${esc(cap.slug)}">Edit</button>
        </div>
      </article>`).join("")}
    </div>
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => showRunForm(button.dataset.run)));
  document.querySelectorAll("[data-edit-cap]").forEach((button) => button.addEventListener("click", () => editCapability(button.dataset.editCap)));
  $("#new-cap").addEventListener("click", () => editCapability());
}

async function showRunForm(slug) {
  const data = await api(`/api/capabilities/${slug}`);
  const cap = data.capability;
  const sample = Object.fromEntries(Object.entries(cap.inputSchema?.properties || {}).map(([key]) => [key, ""]));
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.innerHTML = `<h2>Run ${esc(cap.name)}</h2>
    <form id="run-form" class="form-grid">
      <label>Input JSON<textarea id="run-input">${esc(JSON.stringify(sample, null, 2))}</textarea></label>
      <button class="primary" type="submit">Create Run</button>
    </form>
    <h3>Capability Contract</h3>${json(cap)}`;
  $("#run-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api(`/api/capabilities/${slug}/run`, { method: "POST", body: { input: JSON.parse($("#run-input").value) } });
    location.hash = `runs/${result.run.id}`;
    state.view = `runs/${result.run.id}`;
    await render();
  });
}

async function editCapability(slug = "") {
  const cap = slug ? (await api(`/api/capabilities/${slug}`)).capability : { name: "", slug: "", description: "", category: "General", keywords: [], inputSchema: {}, outputSchema: {}, requiredRunnerTags: [], requiredSkills: [], requiredAgents: [], approvalPolicy: {}, workflow: { type: "builtin", name: "" }, enabled: true };
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.innerHTML = `<h2>${slug ? "Edit" : "New"} Capability</h2>
    <form id="cap-form" class="form-grid">
      <label>Name<input id="cap-name" value="${esc(cap.name)}"></label>
      <label>Slug<input id="cap-slug" value="${esc(cap.slug)}" ${slug ? "disabled" : ""}></label>
      <label>Description<textarea id="cap-description">${esc(cap.description)}</textarea></label>
      <label>Category<input id="cap-category" value="${esc(cap.category)}"></label>
      <label>JSON Definition<textarea id="cap-json">${esc(JSON.stringify(cap, null, 2))}</textarea></label>
      <button class="primary" type="submit">Save Capability</button>
    </form>`;
  $("#cap-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = JSON.parse($("#cap-json").value);
    payload.name = $("#cap-name").value;
    payload.slug = $("#cap-slug").value || payload.slug;
    payload.description = $("#cap-description").value;
    payload.category = $("#cap-category").value;
    if (slug) await api(`/api/capabilities/${slug}`, { method: "PATCH", body: payload });
    else await api("/api/capabilities", { method: "POST", body: payload });
    await renderCapabilities();
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
    <table class="table"><thead><tr><th>Name</th><th>Status</th><th>Tags</th><th>Last heartbeat</th></tr></thead><tbody>
      ${data.runners.map((runner) => `<tr><td>${esc(runner.name)}<br><span class="muted">${esc(runner.id)}</span></td><td>${status(runner.status)}</td><td>${esc((runner.tags || []).join(", "))}</td><td>${esc(runner.lastHeartbeatAt)}</td></tr>`).join("")}
    </tbody></table>
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

async function renderTokens() {
  content.innerHTML = `${toolbar("Access Tokens")}
    <section class="panel">
      <form id="token-form" class="form-grid">
        <label>Name<input id="token-name" value="local agent"></label>
        <button class="primary" type="submit">Create Token</button>
      </form>
      <div id="created-token"></div>
    </section>`;
  $("#token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = await api("/api/tokens", { method: "POST", body: { name: $("#token-name").value, scopes: ["api", "mcp", "runner"] } });
    $("#created-token").innerHTML = `<h3>Token</h3><p class="muted">This value is shown once.</p>${json(data.token)}`;
  });
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
