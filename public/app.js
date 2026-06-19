const state = {
  me: null,
  view: "home",
  telegramAuthAttempted: false,
  telegramAuthError: ""
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
  const icons = {
    succeeded: "✅",
    failed: "❌",
    error: "❌",
    cancelled: "🛑",
    rejected: "⛔",
    running: "▶",
    assigned: "🧭",
    queued: "⏳",
    pending: "⏳",
    waiting_approval: "✋",
    approved: "✅",
    online: "●",
    offline: "○"
  };
  const key = String(value || "").toLowerCase();
  const icon = icons[key] || "•";
  return `<span class="status ${esc(key)}"><span aria-hidden="true">${esc(icon)}</span> ${esc(value)}</span>`;
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
  artifact: (artifact) => artifact?.runId
    ? `#runs/${encodeURIComponent(artifact.runId)}/artifacts/${encodeURIComponent(artifact.id)}`
    : "#runs",
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

// --- First-run empty-state onboarding card -----------------------------------
// Shown on the Workflows view when a fresh tenant has zero workflows. Three
// numbered steps with CTAs that all map to existing endpoints/routes:
//   1. Browse workflow-templates/  → /workflow-templates static index
//   2. Run sample                  → seeds + auto-runs the hello-world template
//   3. Open run detail             → falls through to the auto-opened run page
// CTA wiring happens in bindOnboardingCard() after innerHTML is set.
function onboardingCard() {
  const sample = WORKFLOW_TEMPLATES[0];
  const steps = [
    {
      n: 1,
      title: "Browse workflow templates",
      body: "Start from a curated capability. Each one ships with a sample input and a runner profile.",
      cta: `<a class="button" href="/workflow-templates/" target="_blank" rel="noopener" id="ob-card-browse">Browse templates ↗</a>`
    },
    {
      n: 2,
      title: "Run a sample",
      body: `“${sample.name}” seeds in your tenant, queues a run, and opens its detail page automatically.`,
      cta: `<button class="primary" id="ob-card-run-sample" data-template="${esc(sample.slug)}">Run sample</button>`
    },
    {
      n: 3,
      title: "Open the run detail",
      body: "Watch the live progress strip, browse artifacts, and re-run with one click from the deep-linkable URL.",
      cta: `<a class="button" href="#runs" id="ob-card-open-runs">Open Runs</a>`
    }
  ];
  return `<section class="onboarding-card" role="region" aria-label="Get started in 3 steps">
    <header class="onboarding-card-head">
      <h2>Welcome to Runyard</h2>
      <p class="muted">No workflows yet — follow these three steps to see one running end to end.</p>
    </header>
    <ol class="onboarding-card-steps">
      ${steps.map((step) => `<li class="onboarding-card-step">
        <span class="onboarding-card-num" aria-hidden="true">${step.n}</span>
        <div class="onboarding-card-body">
          <h3>${esc(step.title)}</h3>
          <p class="muted">${esc(step.body)}</p>
          <div class="onboarding-card-cta">${step.cta}</div>
        </div>
      </li>`).join("")}
    </ol>
  </section>`;
}

// --- Next-best-action card ---------------------------------------------------
// Picks the single highest-signal next step a fresh tenant should take, based
// on current state. Returned HTML is injected at the top of the Home view so
// the empty-zero metric tiles stop being the first thing a new user sees.
function nextBestActionCard({ runners = [], capabilities = [], stats = {}, failed24h = 0 }) {
  const offline = runners.filter((r) => !r.online).length;
  const onlineRunners = runners.length - offline;
  // Priority: connect a runner → publish a workflow → investigate failures →
  // celebrate (no action). The button always deep-links to the action surface.
  let title;
  let body;
  let actionHref;
  let actionLabel;
  let tone = "primary";
  if (!runners.length) {
    title = "Connect your first runner";
    body = "A runner executes workflows on a machine you control. Set one up in under a minute and we'll auto-detect it here.";
    actionHref = "#onboarding";
    actionLabel = "Start onboarding";
  } else if (!capabilities.length) {
    title = "Publish your first workflow";
    body = "Workflows are the actions agents and humans can trigger. Start from a template or paste your own.";
    actionHref = "#workflows";
    actionLabel = "Browse templates";
  } else if (failed24h > 0) {
    title = `Investigate ${failed24h} failed run${failed24h === 1 ? "" : "s"}`;
    body = "Recent runs ended in failure. Open them to read the diagnostic timeline and re-run.";
    actionHref = "#runs";
    actionLabel = "Open failed runs";
    tone = "danger";
  } else if (onlineRunners === 0) {
    title = "All runners are offline";
    body = "No runner has heartbeated recently. Start a runner process to begin executing queued work.";
    actionHref = "#runners";
    actionLabel = "View runners";
    tone = "warn";
  } else {
    title = "Everything looks healthy";
    body = "Your runners are online, workflows are published, and no recent failures. Trigger a run to keep the pace.";
    actionHref = "#workflows";
    actionLabel = "Run a workflow";
    tone = "ok";
  }
  return `<section class="nba-card nba-${esc(tone)}" role="region" aria-label="Next best action">
    <div class="nba-body">
      <h2 class="nba-title">${esc(title)}</h2>
      <p class="nba-text">${esc(body)}</p>
    </div>
    <div class="nba-actions"><a class="button primary nba-cta" href="${esc(actionHref)}">${esc(actionLabel)}</a></div>
  </section>`;
}

// --- Sample workflow templates -----------------------------------------------
// Cheap starter capabilities seeded into the tenant when a user clicks
// "Use template" on the empty workflows page. We POST them through the
// existing /api/capabilities upsert path so no server change is needed.
const WORKFLOW_TEMPLATES = [
  {
    slug: "hello-world",
    name: "Hello world",
    category: "starter",
    description: "Prints a greeting from a runner. Quickest way to confirm the pipe is wired end to end.",
    enabled: true,
    requiredRunnerTags: ["smithers"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } } },
    workflow: { type: "shell", entry: "echo 'hello from runyard'" }
  },
  {
    slug: "fetch-and-summarize",
    name: "Fetch & summarize URL",
    category: "starter",
    description: "Downloads a page and asks the default agent to summarize it. Tests outbound HTTP + agent loop.",
    enabled: true,
    requiredRunnerTags: ["smithers", "web"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string", description: "Page to summarize" } } },
    workflow: { type: "shell", entry: "echo summarize $url" }
  },
  {
    slug: "scheduled-check",
    name: "Scheduled health check",
    category: "starter",
    description: "Skeleton for a periodic check: hit an endpoint, alert on failure. Pair with /schedule when ready.",
    enabled: true,
    requiredRunnerTags: ["smithers"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    workflow: { type: "shell", entry: "curl -sf $url" }
  }
];

function templateCard(template) {
  return `<article class="template-card">
    <h3>${esc(template.name)}</h3>
    <p class="muted">${esc(template.description)}</p>
    <p class="template-meta muted">${esc(template.category)} · runs on <code>${esc((template.requiredRunnerTags || []).join(", ") || "any")}</code></p>
    <div class="toolbar-actions">
      <button class="primary" data-use-template="${esc(template.slug)}">Use template</button>
    </div>
  </article>`;
}

function bindTemplateButtons() {
  document.querySelectorAll("[data-use-template]").forEach((button) => {
    if (button.dataset.tplBound === "1") return;
    button.dataset.tplBound = "1";
    button.addEventListener("click", async () => {
      const slug = button.dataset.useTemplate;
      const template = WORKFLOW_TEMPLATES.find((t) => t.slug === slug);
      if (!template) return;
      button.disabled = true;
      try {
        await api("/api/capabilities", { method: "POST", body: template });
        toast(`Created ${template.name}`, "ok");
        setView(`workflows/${template.slug}`);
      } catch (error) {
        toast(error.message || "Could not create template", "error");
        button.disabled = false;
      }
    });
  });
}

// --- Sidebar badges (failed-24h, offline runners) ---------------------------
// A tiny pill rendered inside each sidebar button so an operator sees that
// something needs attention without having to open the tab first. Counts are
// refreshed every 30s and on every navigation; visiting the tab clears it.
const SIDEBAR_BADGE_STATE = { runners: 0, runs: 0 };

function applySidebarBadges() {
  document.querySelectorAll(".sidebar button").forEach((button) => {
    const view = button.dataset.view;
    const existing = button.querySelector(".sidebar-badge");
    let count = 0;
    let tone = "warn";
    if (view === "home") {
      count = SIDEBAR_BADGE_STATE.runs;
      tone = "danger";
    } else if (view === "agents") {
      count = 0;
    }
    if (!count) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      existing.textContent = String(count);
      existing.dataset.tone = tone;
    } else {
      const badge = document.createElement("span");
      badge.className = "sidebar-badge";
      badge.dataset.tone = tone;
      badge.textContent = String(count);
      button.appendChild(badge);
    }
  });
}

async function refreshSidebarBadges() {
  try {
    const [runsData, runnersData] = await Promise.all([
      api("/api/runs?limit=50").catch(() => ({ runs: [] })),
      api("/api/runners").catch(() => ({ runners: [] }))
    ]);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    SIDEBAR_BADGE_STATE.runs = (runsData.runs || []).filter((r) => {
      if (!["failed", "error"].includes(r.status)) return false;
      const t = Date.parse(r.completedAt || r.createdAt || "");
      return Number.isNaN(t) ? true : t >= cutoff;
    }).length;
    SIDEBAR_BADGE_STATE.runners = (runnersData.runners || []).filter((r) => !r.online).length;
    applySidebarBadges();
  } catch {
    // best-effort; badges stay as last known
  }
}

// --- Reveal/hide secret strings ---------------------------------------------
// Masks a high-value secret (token/bearer) behind •••••• with a Show toggle
// and a Copy button that always grabs the real value. Used in token-issued
// confirmations and the MCP config snippets where the bearer leaks easily.
function secretInput(id, value, { label = "Secret" } = {}) {
  return `<div class="copy-row secret-row" data-secret-id="${esc(id)}">
    <input id="${esc(id)}" readonly type="password" value="${esc(value)}" data-secret-value="${esc(value)}" aria-label="${esc(label)}">
    <button type="button" class="button" data-secret-toggle="${esc(id)}">Show</button>
    <button type="button" class="button" data-secret-copy="${esc(id)}">Copy</button>
  </div>`;
}

function bindSecretToggles() {
  document.querySelectorAll("[data-secret-toggle]").forEach((button) => {
    if (button.dataset.secretBound === "1") return;
    button.dataset.secretBound = "1";
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.secretToggle);
      if (!input) return;
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      button.textContent = hidden ? "Hide" : "Show";
    });
  });
  document.querySelectorAll("[data-secret-copy]").forEach((button) => {
    if (button.dataset.secretBound === "1") return;
    button.dataset.secretBound = "1";
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.secretCopy);
      if (!input) return;
      copyText(input.dataset.secretValue || input.value);
    });
  });
}

// --- Tooltip helper ---------------------------------------------------------
// Renders a small "?" badge that explains jargon inline and links into docs.
function helpTip(text, docsAnchor = "") {
  const href = docsAnchor ? `/docs#${esc(docsAnchor)}` : "/docs";
  return `<span class="help-tip" tabindex="0" role="note" aria-label="${esc(text)}">
    <span aria-hidden="true">?</span>
    <span class="help-tip-bubble">${esc(text)} <a href="${esc(href)}">Learn more</a></span>
  </span>`;
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

function breadcrumbs(items) {
  const visible = (items || []).filter((item) => item?.label);
  if (!visible.length) return "";
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
    ${visible.map((item) => {
      const label = esc(item.label);
      const title = item.title || item.label;
      const current = item.current ? ' aria-current="page"' : "";
      return `<li>${item.href
        ? `<a href="${esc(item.href)}" title="${esc(title)}"${current}>${label}</a>`
        : `<span title="${esc(title)}"${current}>${label}</span>`}</li>`;
    }).join("")}
  </ol></nav>`;
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
  document.querySelectorAll(".sidebar button").forEach((button) => {
    const active = button.dataset.view === primary;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".mobile-primary-nav a").forEach((link) => {
    const active = link.dataset.primaryView === primary;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function closeAdminMenu() {
  const menu = document.getElementById("admin-menu");
  if (menu) menu.open = false;
}

function setView(view) {
  state.view = view;
  closeAdminMenu();
  location.hash = view;
  // Visiting Runs / home implies "seen" — drop the runs-failed badge optimistically
  // so the UI feels responsive; the next poll re-derives it from the API.
  if (view === "home" || view === "runs") {
    SIDEBAR_BADGE_STATE.runs = 0;
    applySidebarBadges();
  }
  if (view === "runners") {
    SIDEBAR_BADGE_STATE.runners = 0;
    applySidebarBadges();
  }
  render().catch(showError);
}

function showError(error) {
  content.innerHTML = `<section class="panel"><h2>Something failed</h2><p class="muted">${esc(error.message)}</p></section>`;
}

function telegramWebApp() {
  return window.Telegram?.WebApp || null;
}

function telegramWebAppInitData() {
  return telegramWebApp()?.initData || "";
}

async function authenticateTelegramWebApp() {
  const initData = telegramWebAppInitData();
  if (!initData || state.telegramAuthAttempted) return false;
  state.telegramAuthAttempted = true;
  try {
    await api("/api/auth/telegram-webapp", { method: "POST", body: { initData } });
    state.telegramAuthError = "";
    return true;
  } catch (error) {
    state.telegramAuthError = error.message || "Telegram approval access failed";
    return false;
  }
}

function markTelegramWebAppReady() {
  try {
    telegramWebApp()?.ready?.();
  } catch {
    // Telegram readiness is advisory; Hub auth/rendering should not depend on it.
  }
}

function showAuthFallback() {
  if (state.telegramAuthError && telegramWebApp()) {
    const panel = $("#login .panel");
    if (panel && !$("#telegram-auth-error")) {
      const notice = document.createElement("p");
      notice.id = "telegram-auth-error";
      notice.className = "muted";
      notice.textContent = `Telegram approval access failed: ${state.telegramAuthError}`;
      panel.insertBefore(notice, $("#login-form"));
    }
  }
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

async function bootAuthenticated(data) {
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
  // Best-effort badges: first paint immediately, then poll every 30s.
  // Visiting Runs/Home clears the count locally so the badge updates fast.
  refreshSidebarBadges();
  setInterval(refreshSidebarBadges, 30_000);
  markTelegramWebAppReady();
}

async function boot() {
  try {
    return await bootAuthenticated(await api("/api/me"));
  } catch {
    // Try Telegram Mini App auth once before showing the normal token login.
  }

  if (await authenticateTelegramWebApp()) {
    try {
      return await bootAuthenticated(await api("/api/me"));
    } catch (error) {
      state.telegramAuthError = error.message || "Hub session was not accepted";
    }
  }

  showAuthFallback();
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
    const focusId = segments[3] || "";
    return renderRunDetail(segments[1], { focus, focusId });
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
  if (view === "onboarding") return renderOnboarding();
  if (view === "approvals") return segments[1] ? renderApprovalDetail(segments[1]) : renderApprovals();
  if (view === "runners") return renderRunners();
  if (view === "tokens") return renderTokens();
  if (view === "audit") return renderAudit();
  if (view === "settings") return renderSettings();
  return renderHome();
}

// --- Virtual artifact/log grouping ------------------------------------------
// Display-layer only: we build a human-readable identity folder
// (e.g. "operator--software-audit--05-mar-26") from the run's metadata and use
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

const DIAGNOSTIC_STATUSES = new Set(["failed", "error", "cancelled", "rejected", "waiting_approval"]);

function isDiagnosticRun(run) {
  return run && DIAGNOSTIC_STATUSES.has(run.status);
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

function runExecutionLabel(run) {
  const execution = run?.execution || run?.input?.__execution || {};
  const mode = execution.mode && execution.mode !== "auto" ? execution.mode : "auto";
  const location = execution.runnerLocation || "";
  if (!execution.requested && mode === "auto" && !location) return "";
  return location && mode !== "auto" ? `${mode} (${location})` : mode;
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

// --- Live run progress strip -------------------------------------------------
// Three-phase strip — Queued → Running → Done/Failed — so the operator can
// read run state at a glance instead of squinting at table rows. Drives off
// `run.status` + `run.currentStep`; a stale heartbeat flips the active phase
// to a "stalled" amber tint so killed runners don't masquerade as healthy.
// The DOM is `data-run-progress` so a polling loop can replace this strip in
// place without re-rendering the surrounding card.
const STALL_THRESHOLD_MS = 10_000;

function runPhaseStates(run) {
  const status = run?.status || "";
  const lastBeat = Date.parse(run?.lastHeartbeatAt || run?.updatedAt || run?.startedAt || run?.createdAt || "");
  const stale = Number.isFinite(lastBeat) && (Date.now() - lastBeat) > STALL_THRESHOLD_MS;
  // queued phase
  let queued;
  if (status === "queued") queued = "active";
  else queued = "done";
  // running phase
  let running;
  if (status === "queued") running = "pending";
  else if (status === "running" || status === "assigned" || status === "pending") {
    running = stale ? "stalled" : "active";
  } else if (status === "waiting_approval") running = "active";
  else running = "done";
  // outcome phase
  let outcome;
  if (status === "succeeded") outcome = "ok";
  else if (status === "failed" || status === "error") outcome = "fail";
  else if (status === "cancelled" || status === "rejected") outcome = "cancel";
  else outcome = "pending";
  return { queued, running, outcome };
}

function runProgressStrip(run) {
  const phases = runPhaseStates(run);
  const outcomeLabel = phases.outcome === "ok"
    ? "Done"
    : phases.outcome === "fail"
      ? "Failed"
      : phases.outcome === "cancel"
        ? "Cancelled"
        : "Done";
  const runningLabel = phases.running === "stalled" ? "Stalled" : "Running";
  const items = [
    { key: "queued", label: "Queued", state: phases.queued },
    { key: "running", label: runningLabel, state: phases.running },
    { key: "outcome", label: outcomeLabel, state: phases.outcome }
  ];
  const currentStep = run?.currentStep ? `<span class="run-progress-step-name muted" title="Current step">${esc(run.currentStep)}</span>` : "";
  return `<ol class="run-progress-strip" data-run-progress="${esc(run?.id || "")}" aria-label="Run progress">
    ${items.map((p) => `<li class="run-progress-phase phase-${esc(p.state)}" data-phase="${esc(p.key)}">
      <span class="run-progress-dot" aria-hidden="true"></span>
      <span class="run-progress-label">${esc(p.label)}</span>
    </li>`).join("")}
    ${currentStep}
  </ol>`;
}

// Polls /api/runs/<id> for active runs and replaces the in-place
// `[data-run-progress=<id>]` strip on each tick. Called from any view that
// renders progress strips (home cards, workflow runs tab). The token lets the
// caller cancel when re-rendering, so we don't leak intervals across views.
let progressPollToken = 0;

function pollActiveRunProgress(runIds, { intervalMs = 4000 } = {}) {
  const ids = (runIds || []).filter(Boolean);
  if (!ids.length) return () => {};
  progressPollToken += 1;
  const token = progressPollToken;
  const timer = setInterval(async () => {
    if (token !== progressPollToken) {
      clearInterval(timer);
      return;
    }
    await Promise.all(ids.map(async (id) => {
      try {
        const data = await api(`/api/runs/${encodeURIComponent(id)}`);
        const run = data?.run;
        if (!run) return;
        const node = document.querySelector(`[data-run-progress="${CSS.escape(id)}"]`);
        if (!node) return;
        const tmp = document.createElement("div");
        tmp.innerHTML = runProgressStrip(run);
        const fresh = tmp.firstElementChild;
        if (fresh) node.replaceWith(fresh);
        // Stop polling once the run is no longer active.
        if (!isActiveRun(run)) {
          const remaining = ids.filter((other) => other !== id);
          progressPollToken += 1;
          clearInterval(timer);
          if (remaining.length) pollActiveRunProgress(remaining, { intervalMs });
        }
      } catch {
        // transient network blip — keep polling
      }
    }));
  }, intervalMs);
  return () => {
    progressPollToken += 1;
    clearInterval(timer);
  };
}

// Queued runs get a prominent banner so the home grid + workflow detail can
// answer "is this just sitting in the queue?" at a glance. The position +
// total come from the server-side queue index when available.
function renderQueueBanner(run) {
  const position = run?.queue?.position;
  const total = run?.queue?.total;
  const detail = position
    ? `#${esc(position)}${total ? ` of ${esc(total)}` : ""} · waiting for a runner slot`
    : `waiting for a runner slot`;
  return `<p class="run-queue-banner" title="This run is queued — a runner with matching tags will pick it up next.">
    <span class="run-queue-icon" aria-hidden="true">⏳</span>
    <span class="run-queue-text">In queue</span>
    <span class="run-queue-detail muted">${detail}</span>
  </p>`;
}

function runCard(run, artifacts = []) {
  const active = isActiveRun(run);
  const folder = runFolderLabel(run);
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const origin = run.originLabel || run.origin?.label || "unknown origin";
  const execution = runExecutionLabel(run);
  const dur = runDurationMs(run);
  const durStr = formatDuration(dur);
  const created = relativeTime(run.createdAt);
  const chipsHtml = (project || branch || run.workflowVersion || execution)
    ? `<div class="run-card-chips">
        ${project ? `<span class="chip chip-project" title="Project / target">📦 ${esc(project)}</span>` : ""}
        ${branch ? `<span class="chip chip-branch" title="Branch">🌿 ${esc(branch)}</span>` : ""}
        ${run.workflowVersion ? `<span class="chip chip-version" title="Workflow version">v${esc(run.workflowVersion)}</span>` : ""}
        ${execution ? `<span class="chip chip-runner" title="Execution target">${esc(execution)}</span>` : ""}
      </div>`
    : "";
  const artifactPreview = !active && artifacts.length
    ? `<ul class="artifact-list">
        ${artifacts.slice(0, 3).map((a) => `<li><a href="${esc(deepLinks.artifact(a))}">${esc(artifactDisplayName(a))}</a> <a class="muted artifact-dl" href="/api/artifacts/${esc(a.id)}/download" target="_blank">download</a> <span class="muted">${esc(formatBytes(a.sizeBytes))}</span></li>`).join("")}
        ${artifacts.length > 3 ? `<li class="muted"><a href="${esc(deepLinks.runArtifacts(run.id))}">+${artifacts.length - 3} more</a></li>` : ""}
      </ul>`
    : "";
  // Surface a short reason hint on failed/cancelled cards so the list stays
  // scannable but the operator knows why something stopped.
  const reasonHint = isDiagnosticRun(run) ? (run.reasonHint || "") : "";
  const reasonHintHtml = reasonHint
    ? `<p class="run-reason-hint" title="${esc(reasonHint)}">⚠ <span>${esc(truncate(reasonHint, 140))}</span></p>`
    : "";
  // Queue banner — runs in `queued` state are waiting for a runner slot.
  // The position chip ("#3 of 7") lands when the API ships queue metadata;
  // we degrade to the plain banner when it isn't available (older clients).
  const queueBannerHtml = run.status === "queued" ? renderQueueBanner(run) : "";
  return `<article class="run-card ${active ? "active" : "done"} ${esc(run.status)}" id="run-${esc(run.id)}">
    <header class="run-card-head">
      <div class="run-card-status">${active ? '<span class="run-pulse" aria-hidden="true"></span>' : ""}${status(run.status)}</div>
      ${shareButton(deepLinks.run(run.id), "Copy share link to this run")}
    </header>
    <h3 class="run-card-title"><a href="${esc(deepLinks.run(run.id))}">${esc(title)}</a></h3>
    <p class="run-card-sub">
      ${slug ? `<a class="run-cap-link" href="${esc(deepLinks.workflow(slug))}" title="Open this workflow">${esc(run.capabilityName || slug)}</a>` : ""}
      <span class="run-origin" title="Origin">${esc(origin)}</span>
    </p>
    <p class="muted run-desc">${esc(description)}</p>
    ${runProgressStrip(run)}
    ${queueBannerHtml}
    ${chipsHtml}
    ${reasonHintHtml}
    <p class="muted run-meta">
      <span class="run-step">${esc(run.currentStep || (active ? "starting…" : "—"))}</span>
      <span class="run-timing">${esc(created)}${durStr ? ` · ${esc(durStr)}` : ""}</span>
    </p>
    ${artifactPreview}
    <footer class="run-card-foot">
      <a class="button" href="${esc(slug ? deepLinks.workflow(slug) : deepLinks.workflows())}">Workflow</a>
      <a class="button" href="${esc(deepLinks.runLogs(run.id))}">Run log</a>
      <a class="button" href="${esc(deepLinks.runArtifacts(run.id))}">Artifacts</a>
      <button data-rerun="${esc(run.id)}">Re-run</button>
    </footer>
  </article>`;
}

// --- First-run onboarding wizard --------------------------------------------
// Three steps: (1) name the runner, (2) copy the curl|bash install line with
// the freshly-minted token pre-injected, (3) poll /api/runners until something
// heartbeats and offer a sample workflow to run. The wizard stays at
// /#onboarding so users can come back to it from any deep link.
async function renderOnboarding() {
  content.innerHTML = `${toolbar("Get started", "", "#onboarding")}
    <section class="panel onboarding">
      <ol class="onboarding-steps">
        <li class="onboarding-step active" id="ob-step-1">
          <h2><span class="onboarding-num">1</span> Name your runner</h2>
          <p class="muted">This is the label you'll see in the Runners table. Hostnames work well.</p>
          <form id="onboarding-name-form" class="form-grid">
            <label>Runner name <input id="ob-runner-name" placeholder="e.g. fran-laptop" autocomplete="off"></label>
            <button class="primary" type="submit">Continue</button>
          </form>
        </li>
        <li class="onboarding-step" id="ob-step-2" aria-hidden="true">
          <h2><span class="onboarding-num">2</span> Start the runner</h2>
          <p class="muted">Paste this into a terminal on the machine that will execute work. The token is pre-injected and scoped to <code>runner</code> only.</p>
          <div class="copy-row"><input id="ob-install" readonly value="" aria-label="Install command"><button class="button" data-copy-el="ob-install">Copy</button></div>
          <p class="muted ob-poll-status" id="ob-poll-status">Waiting for runner to connect…</p>
        </li>
        <li class="onboarding-step" id="ob-step-3" aria-hidden="true">
          <h2><span class="onboarding-num">3</span> Run a sample workflow</h2>
          <p class="muted">Your runner is online. Pick a starter and trigger it — the run will appear on the home page.</p>
          <div class="grid ob-templates">${WORKFLOW_TEMPLATES.map(templateCard).join("")}</div>
        </li>
      </ol>
      <p class="muted ob-skip"><a href="#runs" id="ob-skip">Skip the wizard — I'll wire this up later</a></p>
    </section>`;
  bindCopy();
  bindTemplateButtons();
  document.getElementById("ob-skip").addEventListener("click", () => {
    sessionStorage.setItem("onboardingSkipped", "1");
  });
  const nameForm = document.getElementById("onboarding-name-form");
  let pollTimer = null;
  const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  nameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = (document.getElementById("ob-runner-name").value || "").trim() || "runner";
    let token = "";
    try {
      const data = await api("/api/tokens", { method: "POST", body: { name: `onboarding:${name}`, scopes: ["runner"] } });
      token = data.token?.token || "";
    } catch (error) {
      // Token issuance requires admin scope — degrade gracefully so users
      // without that scope still see the install command, just without an
      // auto-injected token. They can paste their own.
      toast(error.message || "Could not auto-mint a runner token — paste your own when prompted", "info");
    }
    const cmd = token
      ? `SMITHERS_HUB_URL=${location.origin} SMITHERS_HUB_TOKEN=${token} SMITHERS_RUNNER_NAME=${name} bash <(curl -fsSL ${location.origin}/install.sh)`
      : `SMITHERS_HUB_URL=${location.origin} SMITHERS_RUNNER_NAME=${name} bash <(curl -fsSL ${location.origin}/install.sh)`;
    document.getElementById("ob-install").value = cmd;
    document.getElementById("ob-step-1").classList.remove("active");
    const step2 = document.getElementById("ob-step-2");
    step2.classList.add("active");
    step2.removeAttribute("aria-hidden");
    step2.scrollIntoView({ behavior: "smooth", block: "start" });
    // Poll for the runner to come online. Once detected, advance to step 3.
    pollTimer = setInterval(async () => {
      try {
        const result = await api("/api/runners");
        const online = (result.runners || []).find((r) => r.online);
        if (!online) return;
        stopPolling();
        document.getElementById("ob-poll-status").innerHTML = `<span class="status online">●</span> Connected as <strong>${esc(online.name)}</strong>`;
        const step3 = document.getElementById("ob-step-3");
        step3.classList.add("active");
        step3.removeAttribute("aria-hidden");
        step3.scrollIntoView({ behavior: "smooth", block: "start" });
        toast(`Runner ${online.name} connected`, "ok");
      } catch {
        // network blip — keep polling
      }
    }, 2500);
  });
}

// --- Home: active runs up top, completed below ------------------------------
async function renderHome() {
  const [runsData, dash, runnersData, capabilitiesData] = await Promise.all([
    api("/api/runs?limit=100"),
    api("/api/dashboard").catch(() => ({ stats: {}, pendingApprovals: [] })),
    api("/api/runners").catch(() => ({ runners: [] })),
    api("/api/capabilities").catch(() => ({ capabilities: [] }))
  ]);
  const runs = runsData.runs || [];
  const runners = runnersData.runners || [];
  const capabilities = capabilitiesData.capabilities || [];
  // First-run gate: a fresh tenant with no runners and no runs is redirected
  // into the guided onboarding wizard once per session. We honor an explicit
  // hash so dismissing the wizard ("Skip" → location.hash="#runs") sticks.
  if (!runners.length && !runs.length && !sessionStorage.getItem("onboardingSkipped") && location.hash !== "#runs" && location.hash !== "#home") {
    setView("onboarding");
    return;
  }
  const active = runs.filter(isActiveRun);
  const completed = runs.filter((r) => !isActiveRun(r));
  // Compute the failed-in-24h count once so both the NBA card and sidebar
  // badge agree on what "needs attention".
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const failed24h = runs.filter((r) => {
    if (!["failed", "error"].includes(r.status)) return false;
    const t = Date.parse(r.completedAt || r.createdAt || "");
    return Number.isNaN(t) ? true : t >= cutoff;
  }).length;
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
  const pool = dash.pool || null;
  const pending = dash.pendingApprovals || [];
  const gettingStarted = (runs.length === 0) && !active.length;
  // Queue + runner pool stats appear inline with the existing home stat strip
  // so the operator sees backlog and capacity without leaving the page.
  const queued = stats.queuedRuns != null ? stats.queuedRuns : runs.filter((r) => r.status === "queued").length;
  const capacityLabel = pool && pool.totalCapacity
    ? `${pool.totalActive}/${pool.totalCapacity} slots`
    : `${stats.runnerActiveSlots ?? 0}/${stats.runnerCapacity ?? 0} slots`;
  content.innerHTML = `${toolbar("Runs", `<button id="home-new-run">Run a workflow</button>`, deepLinks.home())}
    <p class="muted deep-link-hint">Every page, run, workflow, and artifact has a stable URL — click 🔗 to copy a shareable link.</p>
    ${nextBestActionCard({ runners, capabilities, stats, failed24h })}
    ${gettingStarted ? empty("No runs yet.", "Pick a workflow and run it, or start a runner to execute work. Head to Workflows to begin.") : ""}
    ${renderRunnerPoolSummary(pool)}
    <section class="stats home-stats">
      ${Object.entries({
        "Active runs": active.length,
        Queued: queued,
        "Runner capacity": capacityLabel,
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
  document.querySelectorAll("[data-rerun]").forEach((button) => button.addEventListener("click", () => rerunRun(button.dataset.rerun).catch(showError)));
  bindCopy();
  // Keep the per-card progress strip live for any run still in flight. The
  // polling loop is cancelled implicitly when a new view re-renders (it
  // bumps progressPollToken on the next call).
  pollActiveRunProgress(active.map((r) => r.id));
}

function runsTable(runs) {
  if (!runs.length) return `<p class="muted">No runs yet.</p>`;
  const queueChip = (run) => {
    if (run.status !== "queued") return "";
    const pos = run.queue?.position;
    const total = run.queue?.total;
    return ` <span class="chip chip-queue" title="Position in queue">⏳ ${pos ? `#${esc(pos)}${total ? ` / ${esc(total)}` : ""}` : "queued"}</span>`;
  };
  return `<table class="table"><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Step</th><th>Created</th></tr></thead><tbody>
    ${runs.map((run) => `<tr class="${esc(run.status)}"><td data-label="Run"><a href="${esc(deepLinks.run(run.id))}" data-run="${esc(run.id)}">${esc(run.id)}</a></td><td data-label="Workflow">${esc(run.capabilityName)}</td><td data-label="Status">${status(run.status)}${queueChip(run)}</td><td data-label="Step">${esc(run.currentStep)}</td><td data-label="Created">${esc(run.createdAt)}</td></tr>`).join("")}
  </tbody></table>`;
}

async function renderCapabilities() {
  const [data, runsData] = await Promise.all([
    api("/api/capabilities"),
    api("/api/runs?limit=200").catch(() => ({ runs: [] }))
  ]);
  // Bucket the last 10 runs per workflow so each card can show a "last run"
  // chip and a quick success rate without an extra API per card.
  const runsBySlug = new Map();
  for (const run of runsData.runs || []) {
    const slug = run.capabilitySlug;
    if (!slug) continue;
    if (!runsBySlug.has(slug)) runsBySlug.set(slug, []);
    const bucket = runsBySlug.get(slug);
    if (bucket.length < 10) bucket.push(run);
  }
  const workflowStats = (slug) => {
    const bucket = runsBySlug.get(slug) || [];
    if (!bucket.length) return { last: "", success: null, total: 0 };
    const finished = bucket.filter((r) => !isActiveRun(r));
    const ok = finished.filter((r) => r.status === "succeeded").length;
    const rate = finished.length ? Math.round((ok / finished.length) * 100) : null;
    return { last: relativeTime(bucket[0].createdAt), success: rate, total: bucket.length };
  };
  content.innerHTML = `${toolbar("Workflows", `<button id="new-cap">New Workflow</button>`, deepLinks.workflows())}
    <p class="muted">A workflow is a capability your agents can invoke. They appear as MCP tools and as launchable buttons here. Each workflow has a shareable link — open 🔗 to copy.</p>
    ${data.capabilities.length ? `<div class="grid">
      ${data.capabilities.map((cap) => {
        const skills = (cap.requiredSkills || []).slice(0, 4);
        const agents = (cap.requiredAgents || []).slice(0, 4);
        const tags = (cap.requiredRunnerTags || []).slice(0, 4);
        const wfs = workflowStats(cap.slug);
        const lastChip = wfs.last
          ? `<span class="chip chip-last-run" title="Last run">⏱ ${esc(wfs.last)}</span>`
          : `<span class="chip chip-last-run muted" title="No runs yet">never run</span>`;
        const rateChip = wfs.success != null
          ? `<span class="chip chip-success ${wfs.success >= 90 ? "ok" : wfs.success >= 60 ? "warn" : "danger"}" title="Success rate over last ${esc(wfs.total)} run${wfs.total === 1 ? "" : "s"}">✓ ${esc(wfs.success)}%</span>`
          : "";
        return `<article class="item workflow-card" id="workflow-${esc(cap.slug)}">
          <h3><a href="${esc(deepLinks.workflow(cap.slug))}">${esc(cap.name)}</a> ${shareButton(deepLinks.workflow(cap.slug), `Copy share link to ${cap.name}`)}</h3>
          <p class="muted workflow-desc">${esc(cap.description)}</p>
          <p class="workflow-meta">${esc(cap.category)} · v${cap.version} · ${cap.enabled ? "enabled" : "disabled"}${cap.approvalPolicy?.required ? " · needs approval" : ""}</p>
          <p class="workflow-run-chips">${lastChip}${rateChip}</p>
          ${agents.length ? `<div class="pill-row"><span class="pill-label">Agents</span>${pills(agents)}</div>` : ""}
          ${skills.length ? `<div class="pill-row"><span class="pill-label">Skills</span>${pills(skills)}</div>` : ""}
          ${tags.length ? `<div class="pill-row"><span class="pill-label">Runner tags</span>${pills(tags, { kind: "pill tag" })}</div>` : ""}
          <div class="toolbar-actions">
            <a class="button" href="${esc(deepLinks.workflow(cap.slug))}">Open</a>
            <button data-run="${esc(cap.slug)}" class="primary" title="Run this workflow now">▶ Run</button>
            <button data-edit-cap="${esc(cap.slug)}">Edit</button>
          </div>
        </article>`;
      }).join("")}
    </div>` : `${onboardingCard()}
      <h2 class="section-heading">Starter templates</h2>
      <div class="grid template-grid">${WORKFLOW_TEMPLATES.map(templateCard).join("")}</div>`}
    <section id="editor" class="panel hidden"></section>`;
  document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => setView(`workflows/${button.dataset.run}/run`)));
  document.querySelectorAll("[data-edit-cap]").forEach((button) => button.addEventListener("click", () => editCapability(button.dataset.editCap)));
  $("#new-cap").addEventListener("click", () => editCapability());
  bindCopy();
  bindTemplateButtons();
  bindOnboardingCard();
}

// Wires the empty-state "Run sample" button: seed the hello-world template if
// it isn't already there, queue a run, then route to the run detail. We reuse
// the existing /api/capabilities POST + /api/capabilities/<slug>/run endpoints
// so no server change is needed.
function bindOnboardingCard() {
  const btn = document.getElementById("ob-card-run-sample");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    const slug = btn.dataset.template;
    const template = WORKFLOW_TEMPLATES.find((t) => t.slug === slug) || WORKFLOW_TEMPLATES[0];
    if (!template) return;
    btn.disabled = true;
    const restore = btn.textContent;
    btn.textContent = "Starting…";
    try {
      // Upsert is idempotent on slug, so a second click after a refresh just
      // re-runs the existing capability.
      try {
        await api("/api/capabilities", { method: "POST", body: template });
      } catch {
        // Already exists — ignore and continue to the run step.
      }
      const result = await api(`/api/capabilities/${encodeURIComponent(template.slug)}/run`, { method: "POST", body: { input: {} } });
      const runId = result?.run?.id;
      toast(`Sample run queued`, "ok");
      if (runId) {
        location.hash = deepLinks.run(runId).slice(1);
        state.view = `runs/${runId}`;
        await render();
      } else {
        setView("home");
      }
    } catch (error) {
      toast(error.message || "Could not start sample run", "error");
      btn.disabled = false;
      btn.textContent = restore;
    }
  });
}

// --- Workflow detail page ---------------------------------------------------
// Renders the rich detail view for one workflow with explicit tabs:
//   Overview      — description, required agents/skills/runner tags, policy
//   Visual graph  — ReactFlow renderer over workflow source/metadata
//   Code          — syntax-highlighted source viewer (Code / Agents / Graph)
//   Runs          — recent runs for this workflow, plus the "Run" form
// Tabs are deep-linkable via #workflows/<slug>/<tab>.
const WORKFLOW_TABS = [
  { key: "overview", label: "Overview", aliases: ["", "edit"] },
  { key: "graph", label: "Visual graph", aliases: ["visual", "diagram"] },
  { key: "code", label: "Code", aliases: ["source"] },
  { key: "runs", label: "Runs", aliases: ["run"] }
];

function resolveWorkflowTab(sub) {
  const value = String(sub || "").toLowerCase();
  for (const tab of WORKFLOW_TABS) {
    if (tab.key === value) return tab.key;
    if (tab.aliases.includes(value)) return tab.key;
  }
  return "overview";
}

async function renderWorkflowDetail(slug, { sub = "" } = {}) {
  let cap;
  try {
    const data = await api(`/api/capabilities/${slug}`);
    cap = data.capability;
  } catch (error) {
    content.innerHTML = `${breadcrumbs([
      { label: "Workflows", href: deepLinks.workflows() },
      { label: slug, href: deepLinks.workflow(slug), current: true }
    ])}${toolbar("Workflow", "", deepLinks.workflow(slug))}<section class="panel"><p class="muted">${esc(error.message)}</p><p><a href="${esc(deepLinks.workflows())}">Back to workflows</a></p></section>`;
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
  const activeTab = resolveWorkflowTab(sub);
  const tabsHtml = WORKFLOW_TABS
    .map((tab) => `<a class="tab ${tab.key === activeTab ? "active" : ""}" data-wf-tab="${tab.key}" href="#workflows/${encodeURIComponent(slug)}/${tab.key === "overview" ? "" : tab.key}">${esc(tab.label)}</a>`)
    .join("");
  const headerActions = `
    <button id="wf-run" class="primary">Run this workflow</button>
    <button id="wf-edit">Edit</button>
    <a class="button" href="${esc(deepLinks.workflows())}">All workflows</a>
  `;
  const crumbNav = breadcrumbs([
    { label: "Workflows", href: deepLinks.workflows() },
    { label: cap.name || slug, href: deepLinks.workflow(slug), current: true }
  ]);

  const overviewHtml = `
    <section class="split workflow-tab-body">
      <div class="panel" id="panel-wf-detail">
        ${agents.length ? `<h3>Required agents</h3>${pills(agents, { link: (s) => deepLinks.agent(s) })}` : ""}
        ${skills.length ? `<h3>Required skills</h3>${pills(skills, { link: (s) => deepLinks.skill(s) })}` : ""}
        ${tags.length ? `<h3>Runner tags</h3>${pills(tags, { kind: "pill tag" })}` : ""}
        <h3>Approval policy</h3>
        ${approval.required
          ? `<p class="notice">This workflow can ask for approval at checkpoints while it runs.${approval.reason ? ` ${esc(approval.reason)}` : ""}</p>`
          : `<p class="muted">No approval required — runs start as soon as a matching runner picks them up.</p>`}
        <h3>Workflow entry</h3>
        ${entryLabel
          ? `<p><span class="kbd">${esc(entryLabel)}</span>${workflow.engine ? ` <span class="muted">· engine ${esc(workflow.engine)}</span>` : ""}</p>`
          : `<p class="muted">No explicit entry registered.</p>`}
        <p class="muted">Open the <a href="#workflows/${esc(slug)}/graph">Visual graph</a> tab to see the ReactFlow diagram, or <a href="#workflows/${esc(slug)}/code">Code</a> to read the source.</p>
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
        ${runs.length > 8 ? `<p class="muted"><a href="#workflows/${esc(slug)}/runs">See all ${runs.length}</a></p>` : ""}
      </div>
    </section>`;

  const graphHtml = `
    <section class="workflow-tab-body workflow-graph-tab">
      <div class="panel workflow-graph-panel">
        <header class="workflow-graph-header">
          <div>
            <h3>Visual graph</h3>
            <p class="muted">Smithers source is the source of truth. The canvas renders the workflow JSX into nodes, handles, and edges — pan and zoom with ReactFlow controls.</p>
          </div>
          <div class="workflow-graph-actions">
            <button type="button" id="wf-graph-fit" class="button">Fit view</button>
            <a class="button" href="#workflows/${esc(slug)}/code">Read source</a>
          </div>
        </header>
        <div class="workflow-graph-host" id="wf-graph-host">
          <div class="workflow-graph-loading muted">Loading ReactFlow…</div>
        </div>
        <noscript>
          <p class="muted">Enable JavaScript to see the interactive ReactFlow diagram. A static fallback is available in the Code tab.</p>
        </noscript>
      </div>
    </section>`;

  const codeHtml = `
    <section class="workflow-tab-body workflow-code-tab">
      <div class="panel workflow-code-panel">
        <header class="workflow-code-header">
          <div>
            <h3>Code</h3>
            <p class="muted" id="wf-code-path">Loading source…</p>
          </div>
          <div class="workflow-code-actions">
            <nav class="tabs subtabs" id="wf-code-subtabs" aria-label="Source sections"></nav>
            <button type="button" id="wf-code-copy" class="button" disabled>Copy source</button>
          </div>
        </header>
        <div class="workflow-code-host" id="wf-code-host">
          <p class="muted">Fetching the workflow source…</p>
        </div>
      </div>
    </section>`;

  const runsHtml = `
    <section class="workflow-tab-body workflow-runs-tab">
      <div class="panel">
        <header class="workflow-runs-header">
          <div>
            <h3>Recent runs ${shareButton(deepLinks.workflowRuns(slug), "Copy share link to this workflow's runs")}</h3>
            <p class="muted">${runs.length ? `Last ${Math.min(runs.length, 20)} runs of <strong>${esc(cap.name || slug)}</strong>.` : "No runs yet."}</p>
          </div>
          <button id="wf-run-2" class="primary">Run this workflow</button>
        </header>
        ${runs.length ? workflowRunsList(runs.slice(0, 20)) : empty("No runs yet.", "Trigger a run to see the timeline, artifacts, and outputs here.")}
      </div>
    </section>`;

  content.innerHTML = `${crumbNav}${toolbar(cap.name, headerActions, deepLinks.workflow(slug))}
    <p class="muted workflow-detail-desc">${esc(cap.description || "No description.")}</p>
    <p class="workflow-meta-row muted">
      <span>${esc(cap.category || "General")}</span>
      <span>·</span>
      <span>v${esc(cap.version)}</span>
      <span>·</span>
      <span>${cap.enabled ? "enabled" : "disabled"}</span>
      ${approval.required ? `<span>·</span><span class="status waiting_approval">has approval checkpoints</span>` : ""}
    </p>
    <nav class="tabs workflow-tabs" aria-label="Workflow sections">${tabsHtml}</nav>
    <div id="workflow-tab-body">
      ${activeTab === "overview" ? overviewHtml : ""}
      ${activeTab === "graph" ? graphHtml : ""}
      ${activeTab === "code" ? codeHtml : ""}
      ${activeTab === "runs" ? runsHtml : ""}
    </div>
    <section id="editor" class="panel hidden"></section>`;

  $("#wf-run").addEventListener("click", () => setView(`workflows/${slug}/run`));
  $("#wf-edit").addEventListener("click", () => editCapability(slug));
  document.querySelectorAll("[data-wf-tab]").forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      const target = anchor.dataset.wfTab;
      setView(`workflows/${slug}${target === "overview" ? "" : `/${target}`}`);
    });
  });
  bindCopy();

  if (activeTab === "graph") {
    await renderWorkflowGraphTab(slug, cap);
  } else if (activeTab === "code") {
    await renderWorkflowCodeTab(slug, cap);
  } else if (activeTab === "runs") {
    $("#wf-run-2")?.addEventListener("click", () => setView(`workflows/${slug}/run`));
    // Stream live status onto every active run's progress strip until the
    // user navigates away (re-render bumps progressPollToken).
    pollActiveRunProgress(runs.filter(isActiveRun).map((r) => r.id));
  } else if (activeTab === "overview") {
    // The overview also surfaces "Latest runs" on the side rail — keep those
    // strips ticking so a fresh user sees their sample run finish in place.
    pollActiveRunProgress(runs.slice(0, 8).filter(isActiveRun).map((r) => r.id));
  }

  if (sub === "run") {
    await showRunForm(slug);
  } else if (sub === "edit") {
    await editCapability(slug);
  }
}

// --- Workflow Code tab (highlight.js viewer) --------------------------------
// Pulls /api/capabilities/<slug>/source and renders syntax-highlighted code.
// Sub-tabs split the file into Code / Agents / Graph slices when those
// sections are detectable in the source.
async function renderWorkflowCodeTab(slug, cap) {
  const host = $("#wf-code-host");
  const subtabs = $("#wf-code-subtabs");
  const pathEl = $("#wf-code-path");
  const copyBtn = $("#wf-code-copy");
  if (!host) return;
  let payload;
  try {
    payload = await api(`/api/capabilities/${encodeURIComponent(slug)}/source`);
  } catch (error) {
    host.innerHTML = `<p class="notice">Could not load workflow source: ${esc(error.message)}</p>`;
    return;
  }
  if (!payload.available) {
    host.innerHTML = `<p class="muted">${esc(payload.message || "No workflow source file shipped for this capability.")}</p>
      <p class="muted">Registered entry: <code>${esc(cap?.workflow?.entry || "—")}</code></p>`;
    return;
  }
  pathEl.textContent = `${payload.path} · ${payload.language.toUpperCase()} · ${formatBytes(payload.sizeBytes)}`;
  copyBtn.disabled = false;
  copyBtn.addEventListener("click", () => copyText(payload.code));

  const sections = payload.sections || {};
  const sectionDefs = [
    { key: "code", label: "Code", body: payload.code || "" },
    { key: "agents", label: "Agents", body: sections.agents?.text || "" },
    { key: "workflowGraph", label: "workflowGraph", body: sections.workflowGraph?.text || "" }
  ].filter((entry) => entry.body && entry.body.trim().length);

  subtabs.innerHTML = sectionDefs
    .map((entry, index) => `<button type="button" class="tab ${index === 0 ? "active" : ""}" data-code-section="${esc(entry.key)}">${esc(entry.label)}</button>`)
    .join("");

  const highlighter = await loadHighlighter();
  function render(section) {
    const def = sectionDefs.find((entry) => entry.key === section) || sectionDefs[0];
    if (!def) {
      host.innerHTML = `<p class="muted">No code to display.</p>`;
      return;
    }
    const language = payload.language === "tsx" || payload.language === "ts" ? "typescript" : payload.language === "jsx" || payload.language === "js" ? "javascript" : payload.language;
    host.innerHTML = `<pre class="workflow-code"><code class="hljs language-${esc(language || "plaintext")}">${esc(def.body)}</code></pre>`;
    if (highlighter) {
      try {
        highlighter.highlightElement(host.querySelector("code"));
      } catch {
        // best-effort; raw escaped text is already legible.
      }
    }
  }

  document.querySelectorAll("[data-code-section]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-code-section]").forEach((b) => b.classList.toggle("active", b === button));
      render(button.dataset.codeSection);
    });
  });
  render(sectionDefs[0]?.key || "code");
}

let highlighterPromise = null;
async function loadHighlighter() {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = import(/* @vite-ignore */ "/public/vendor/highlight.bundle.js")
    .then((module) => module?.default || module?.hljs || null)
    .catch(() => null);
  return highlighterPromise;
}

// --- Workflow Visual graph tab (ReactFlow renderer) -------------------------
async function renderWorkflowGraphTab(slug, cap) {
  const host = $("#wf-graph-host");
  if (!host) return;
  let payload;
  try {
    payload = await api(`/api/capabilities/${encodeURIComponent(slug)}/source`);
  } catch (error) {
    host.innerHTML = `<p class="notice">Could not load workflow graph: ${esc(error.message)}</p>`;
    return;
  }
  const graph = payload.graph || deriveClientGraphFallback(cap);
  const reactflow = await loadReactFlow();
  if (!reactflow) {
    host.innerHTML = renderStaticGraphSvg(graph) +
      `<p class="muted graph-fallback-note">ReactFlow bundle could not be loaded; showing static fallback. Re-run <code>pnpm build:vendor</code> on the server to refresh the vendored ReactFlow bundle.</p>`;
    return;
  }
  try {
    mountReactFlowGraph(reactflow, host, graph);
  } catch (error) {
    host.innerHTML = renderStaticGraphSvg(graph) +
      `<p class="muted graph-fallback-note">ReactFlow failed to mount (${esc(error.message)}). Showing static fallback.</p>`;
  }
}

let reactFlowPromise = null;
async function loadReactFlow() {
  if (reactFlowPromise) return reactFlowPromise;
  reactFlowPromise = import(/* @vite-ignore */ "/public/vendor/reactflow.bundle.js")
    .then((module) => module || null)
    .catch(() => null);
  return reactFlowPromise;
}

function deriveClientGraphFallback(cap = {}) {
  return {
    name: cap?.name || cap?.slug || "Workflow",
    nodes: [
      { id: "workflow", kind: "entry", label: cap?.name || cap?.slug || "Workflow" },
      { id: "execute", kind: "task", label: cap?.workflow?.entry || cap?.workflow?.name || "execute" }
    ],
    edges: [{ id: "e-workflow-execute", source: "workflow", target: "execute", kind: "sequence" }],
    sideNodes: []
  };
}

function layoutGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  // Compute the "rank" of each node from the workflow entry using BFS.
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) if (adjacency.has(edge.source)) adjacency.get(edge.source).push(edge.target);
  const rank = new Map();
  const entry = nodes.find((node) => node.kind === "entry") || nodes[0];
  if (!entry) return { positions: new Map(), columns: [] };
  const queue = [[entry.id, 0]];
  rank.set(entry.id, 0);
  while (queue.length) {
    const [id, r] = queue.shift();
    for (const next of adjacency.get(id) || []) {
      if (!rank.has(next) || rank.get(next) < r + 1) {
        rank.set(next, r + 1);
        queue.push([next, r + 1]);
      }
    }
  }
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  const columns = new Map();
  for (const node of nodes) {
    const column = rank.get(node.id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  const positions = new Map();
  const columnWidth = 230;
  const rowHeight = 110;
  for (const [column, items] of columns.entries()) {
    items.forEach((node, index) => {
      const x = column * columnWidth;
      const y = (index - (items.length - 1) / 2) * rowHeight;
      positions.set(node.id, { x, y });
    });
  }
  return { positions, columns: Array.from(columns.entries()) };
}

function nodeColor(kind) {
  switch (kind) {
    case "entry": return { background: "#0f766e", color: "#fff", border: "#0d5e57" };
    case "approval": return { background: "#fffbeb", color: "#b45309", border: "#fcd34d" };
    case "deploy": return { background: "#ecfeff", color: "#0e7490", border: "#67e8f9" };
    case "test": return { background: "#eef2ff", color: "#4338ca", border: "#a5b4fc" };
    case "commit":
    case "push": return { background: "#f5f3ff", color: "#6d28d9", border: "#c4b5fd" };
    case "build": return { background: "#fef3c7", color: "#92400e", border: "#fcd34d" };
    case "verify": return { background: "#dcfce7", color: "#166534", border: "#86efac" };
    case "agent":
    case "skill":
    case "tag": return { background: "#f1f5f9", color: "#334155", border: "#cbd5f5" };
    default: return { background: "#ffffff", color: "#15191f", border: "#d9e0ea" };
  }
}

function mountReactFlowGraph(reactflow, host, graph) {
  const { React, ReactDOMClient, ReactFlow } = reactflow;
  if (!React || !ReactDOMClient || !ReactFlow) throw new Error("vendor bundle missing React/ReactFlow exports");
  const { positions } = layoutGraph(graph);

  const reactNodes = (graph.nodes || []).map((node) => {
    const palette = nodeColor(node.kind);
    return {
      id: node.id,
      data: { label: nodeLabel(node) },
      position: positions.get(node.id) || { x: 0, y: 0 },
      style: {
        borderRadius: 10,
        border: `1px solid ${palette.border}`,
        background: palette.background,
        color: palette.color,
        padding: "10px 14px",
        minWidth: 168,
        fontSize: 13,
        boxShadow: "0 4px 12px rgba(15, 25, 35, 0.08)"
      },
      type: node.kind === "entry" ? "input" : "default"
    };
  });
  const reactEdges = (graph.edges || []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.kind === "parallel",
    label: edge.kind === "parallel" ? "parallel" : undefined,
    style: { stroke: edge.kind === "parallel" ? "#0ea5e9" : "#637083" }
  }));

  host.innerHTML = "";
  host.classList.add("workflow-graph-mounted");
  const root = ReactDOMClient.createRoot(host);
  const Component = React.createElement(GraphCanvas, {
    React,
    ReactFlow,
    nodes: reactNodes,
    edges: reactEdges,
    sideNodes: graph.sideNodes || []
  });
  root.render(Component);
}

function nodeLabel(node) {
  const lines = [node.label || node.id];
  if (node.sublabel) lines.push(node.sublabel);
  return lines.join("\n");
}

function GraphCanvas({ React, ReactFlow, nodes, edges, sideNodes }) {
  const { ReactFlow: Flow, Background, Controls, MiniMap } = ReactFlow;
  const Provider = ReactFlow.ReactFlowProvider;
  const instanceRef = React.useRef(null);
  const onInit = React.useCallback((instance) => {
    instanceRef.current = instance;
    setTimeout(() => instance.fitView({ padding: 0.2 }), 0);
  }, []);
  React.useEffect(() => {
    const button = document.getElementById("wf-graph-fit");
    if (!button) return undefined;
    const handler = () => instanceRef.current?.fitView({ padding: 0.2, duration: 400 });
    button.addEventListener("click", handler);
    return () => button.removeEventListener("click", handler);
  }, []);
  const sideHtml = (sideNodes || []).map((node) =>
    React.createElement("li", { key: node.id, className: `graph-side-pill graph-side-${node.kind}` }, node.label)
  );
  return React.createElement(
    "div",
    { className: "workflow-graph-canvas" },
    React.createElement(
      Provider,
      null,
      React.createElement(
        Flow,
        {
          nodes,
          edges,
          fitView: true,
          fitViewOptions: { padding: 0.2 },
          onInit,
          minZoom: 0.2,
          maxZoom: 2,
          proOptions: { hideAttribution: true }
        },
        React.createElement(Background, { gap: 18, color: "#d9e0ea" }),
        React.createElement(Controls, { showInteractive: false }),
        React.createElement(MiniMap, { pannable: true, zoomable: true })
      )
    ),
    sideHtml.length
      ? React.createElement(
          "aside",
          { className: "workflow-graph-side" },
          React.createElement("strong", null, "Required by workflow"),
          React.createElement("ul", null, ...sideHtml)
        )
      : null
  );
}

// Static SVG fallback — only rendered if the ReactFlow vendor bundle can't
// be loaded. Keeps the page useful for no-JS / failed-network scenarios.
function renderStaticGraphSvg(graph) {
  const { positions } = layoutGraph(graph);
  const nodes = (graph.nodes || []).map((node) => ({ ...node, position: positions.get(node.id) || { x: 0, y: 0 } }));
  if (!nodes.length) return `<p class="muted">No graph nodes derived from source.</p>`;
  const padding = 32;
  const minX = Math.min(...nodes.map((n) => n.position.x)) - padding;
  const maxX = Math.max(...nodes.map((n) => n.position.x)) + 200 + padding;
  const minY = Math.min(...nodes.map((n) => n.position.y)) - padding;
  const maxY = Math.max(...nodes.map((n) => n.position.y)) + 80 + padding;
  const width = Math.max(maxX - minX, 480);
  const height = Math.max(maxY - minY, 200);
  const positionById = new Map(nodes.map((node) => [node.id, node.position]));
  const edgesHtml = (graph.edges || [])
    .map((edge) => {
      const src = positionById.get(edge.source);
      const dst = positionById.get(edge.target);
      if (!src || !dst) return "";
      const x1 = src.x + 200 - minX;
      const y1 = src.y + 32 - minY;
      const x2 = dst.x - minX;
      const y2 = dst.y + 32 - minY;
      const stroke = edge.kind === "parallel" ? "#0ea5e9" : "#637083";
      return `<path d="M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}" stroke="${stroke}" stroke-width="1.5" fill="none" stroke-dasharray="${edge.kind === "parallel" ? "4 4" : ""}"/>`;
    })
    .join("");
  const nodesHtml = nodes
    .map((node) => {
      const palette = nodeColor(node.kind);
      const x = node.position.x - minX;
      const y = node.position.y - minY;
      const label = (node.label || node.id || "").slice(0, 32);
      const sub = (node.sublabel || "").slice(0, 40);
      return `<g transform="translate(${x},${y})">
        <rect width="200" height="64" rx="10" ry="10" fill="${palette.background}" stroke="${palette.border}" />
        <text x="14" y="26" font-size="13" fill="${palette.color}" font-weight="600">${esc(label)}</text>
        ${sub ? `<text x="14" y="46" font-size="11" fill="${palette.color}" opacity="0.7">${esc(sub)}</text>` : ""}
      </g>`;
    })
    .join("");
  return `<svg class="workflow-graph-static" viewBox="0 0 ${width} ${height}" role="img" aria-label="Workflow graph (static fallback)">
    <defs></defs>
    ${edgesHtml}
    ${nodesHtml}
  </svg>`;
}

function workflowRunsList(runs) {
  return `<ul class="wf-run-list">${runs.map((run) => {
    const title = runTitle(run);
    const dur = formatDuration(runDurationMs(run));
    const project = runProject(run);
    const branch = runBranch(run);
    const active = isActiveRun(run);
    // Active runs default to expanded so users see the progress strip
    // immediately; completed runs collapse to a one-liner that the user can
    // expand to inspect after the fact.
    return `<li class="wf-run-row">
      <details class="wf-run-progress-details" ${active ? "open" : ""}>
        <summary class="wf-run-progress-summary">
          <a href="${esc(deepLinks.run(run.id))}" class="wf-run-title">${esc(title)}</a>
          <span class="wf-run-status">${status(run.status)}</span>
          <span class="muted wf-run-when">${esc(relativeTime(run.createdAt))}${dur ? ` · ${esc(dur)}` : ""}</span>
          ${project ? `<span class="chip chip-project">📦 ${esc(project)}</span>` : ""}
          ${branch ? `<span class="chip chip-branch">🌿 ${esc(branch)}</span>` : ""}
        </summary>
        <div class="wf-run-progress-body">
          ${runProgressStrip(run)}
        </div>
      </details>
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
    ${approval ? `<p class="notice">This workflow may ask for approval at checkpoints while it runs.${cap.approvalPolicy?.reason ? ` ${esc(cap.approvalPolicy.reason)}` : ""}</p>` : ""}
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
      toast("Run created", "ok");
      // Landing's "Try it" CTA sends users here with ?try=<slug>. After the
      // sample run is queued, route them to /app#connect so they wire MCP,
      // CLI, API, or a runner pool *after* seeing a capability succeed.
      const tryParam = new URLSearchParams(location.search).get("try");
      if (tryParam && tryParam === slug) {
        const url = new URL(location.href);
        url.searchParams.delete("try");
        window.history.replaceState({}, "", `${url.pathname}${url.search}#connect`);
        state.view = "connect";
        await render();
        return;
      }
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

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// --- Diagnostic panel for failed/cancelled/error/waiting_approval runs -----
// Surfaces the *why* up-front: short reason, who/what cancelled, the failed
// step, an approval-comment quote if that was the cause, a focused timeline,
// a recent stderr/stdout window, and any diagnostic-looking artifacts.
function renderRunDiagnostics(diagnostics) {
  if (!diagnostics) return "";
  const statusKey = diagnostics.status || "";
  const intro =
    statusKey === "waiting_approval"
      ? "This run is paused waiting for an approval decision."
      : statusKey === "failed" || statusKey === "error"
        ? "This run failed. Diagnostic details below."
        : "This run was cancelled. Diagnostic details below.";
  const headline = diagnostics.headline ? `<p class="diagnostics-headline">${esc(diagnostics.headline)}</p>` : "";
  const facts = [
    diagnostics.failedStep ? `<dt>Failed step</dt><dd>${esc(diagnostics.failedStep)}</dd>` : "",
    diagnostics.failureType ? `<dt>Failure event</dt><dd><code>${esc(diagnostics.failureType)}</code></dd>` : "",
    diagnostics.failedAt ? `<dt>When</dt><dd>${esc(formatTimestamp(diagnostics.failedAt))}</dd>` : "",
    diagnostics.cancelledBy ? `<dt>Cancelled by</dt><dd>${esc(diagnostics.cancelledBy)}</dd>` : "",
    diagnostics.approval
      ? `<dt>Linked approval</dt><dd><a href="${esc(diagnostics.approval.deepLink)}">${esc(diagnostics.approval.title || diagnostics.approval.id)}</a> <span class="muted">${esc(diagnostics.approval.decision || diagnostics.approval.status || "")}</span></dd>`
      : ""
  ].filter(Boolean).join("");
  const reasonBlock = diagnostics.reason && diagnostics.reason !== diagnostics.headline
    ? `<details class="diagnostics-reason" open><summary>Reason</summary>
        <pre class="diagnostics-pre"><code>${esc(diagnostics.reason)}</code></pre>
        <button type="button" class="button copy-btn" data-copy="${esc(diagnostics.reason)}" title="Copy reason">Copy reason</button>
      </details>`
    : "";
  const approvalQuote = diagnostics.approval?.comment
    ? `<div class="diagnostics-approval-quote">
        <h4>Approval comment</h4>
        <blockquote>${esc(diagnostics.approval.comment)}</blockquote>
        <p class="muted">${esc(diagnostics.approval.resolvedBy || diagnostics.approval.requestedBy || "approval")}${diagnostics.approval.resolvedAt ? ` · ${esc(formatTimestamp(diagnostics.approval.resolvedAt))}` : ""}</p>
        <button type="button" class="button copy-btn" data-copy="${esc(diagnostics.approval.comment)}" title="Copy approval comment">Copy comment</button>
      </div>`
    : "";
  const timeline = Array.isArray(diagnostics.timeline) ? diagnostics.timeline : [];
  const timelineHtml = timeline.length
    ? `<div class="diagnostics-timeline">
        <h4>Events around the failure</h4>
        <ol class="diagnostics-event-list">
          ${timeline.map((event) => `<li>
            <time>${esc(formatTimestamp(event.createdAt))}</time>
            <code class="diagnostics-event-type">${esc(event.type)}</code>
            <span class="diagnostics-event-msg">${esc(event.message || "")}</span>
          </li>`).join("")}
        </ol>
      </div>`
    : "";
  const logs = Array.isArray(diagnostics.logExcerpts) ? diagnostics.logExcerpts : [];
  const logsHtml = logs.length
    ? `<div class="diagnostics-logs">
        <div class="diagnostics-logs-head">
          <h4>Recent log excerpts</h4>
          <button type="button" class="button copy-btn" data-copy="${esc(logs.map((entry) => `[${entry.createdAt}] ${entry.type}: ${entry.message}`).join("\n"))}" title="Copy log excerpt">Copy log</button>
        </div>
        <pre class="diagnostics-pre"><code>${esc(logs.map((entry) => `[${entry.createdAt}] ${entry.type}: ${entry.message}`).join("\n"))}</code></pre>
        <p class="muted">Token/secret-shaped strings are redacted in this excerpt.</p>
      </div>`
    : "";
  const arts = Array.isArray(diagnostics.artifacts) ? diagnostics.artifacts : [];
  const artifactsHtml = arts.length
    ? `<div class="diagnostics-artifacts">
        <h4>Diagnostic artifacts</h4>
        <ul class="artifact-list">
          ${arts.map((artifact) => `<li><a href="${esc(deepLinks.artifact(artifact))}">${esc(artifactDisplayName(artifact))}</a> <a class="muted artifact-dl" href="/api/artifacts/${esc(artifact.id)}/download" target="_blank">download</a> <span class="muted">${esc(formatBytes(artifact.sizeBytes))}</span></li>`).join("")}
        </ul>
      </div>`
    : "";
  return `<section class="panel diagnostics-panel diagnostics-${esc(statusKey)}" aria-label="Run diagnostics">
    <header class="diagnostics-head">
      <h2>Why this run ${statusKey === "waiting_approval" ? "is paused" : statusKey === "failed" || statusKey === "error" ? "failed" : "was cancelled"}</h2>
      ${status(statusKey)}
    </header>
    <p class="muted diagnostics-intro">${esc(intro)}</p>
    ${headline}
    ${facts ? `<dl class="diagnostics-facts">${facts}</dl>` : ""}
    ${approvalQuote}
    ${reasonBlock}
    ${timelineHtml}
    ${logsHtml}
    ${artifactsHtml}
  </section>`;
}

// --- Structured run-log view ------------------------------------------------
// The raw firehose of events is unreadable for any non-trivial run. We render
// a scannable default: a counts strip, category + severity filter chips, a
// highlights list seeded from the server-side summary, and a collapsible Full
// timeline that hides noisy categories until the operator asks for them. The
// raw view is always one click away via copy/download, and the redaction pass
// already happened on the server.
const RUN_LOG_NOISY_CATEGORIES = new Set(["noise", "trace"]);
const RUN_LOG_CATEGORY_LABELS = {
  run: "Run",
  node: "Node",
  approval: "Approval",
  agent: "Agent",
  step: "Step",
  log: "Log",
  other: "Other",
  trace: "Trace",
  noise: "Heartbeat"
};
const RUN_LOG_SEVERITY_LABELS = { error: "Errors", warn: "Warnings", info: "Info" };

function runLogTextDump(events) {
  return (events || [])
    .map((event) => `[${event.createdAt}] ${event.type}: ${event.message || ""}`)
    .join("\n");
}

function eventCategoryClient(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)heartbeat$|^heartbeat$|\.tick$|\.ping$/i.test(type)) return "noise";
  if (/\.(?:trace|span|delta|chunk|tool_use|tool_result|thinking)$/i.test(type)) return "trace";
  if (/^approval\./i.test(type)) return "approval";
  if (/^run\./i.test(type)) return "run";
  if (/^(?:node|task|step)\./i.test(type)) return "node";
  if (/^workflow\.step$/i.test(type)) return "step";
  if (/^(?:agent|claude|codex)\.(?:summary|result|completed|final)$/i.test(type)) return "agent";
  if (type === "log" || type === "stdout" || type === "stderr" || /\.(?:log|stdout|stderr)$/i.test(type)) return "log";
  return "other";
}

function eventSeverityClient(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)(?:failed|errored|fatal|panic)$/i.test(type)) return "error";
  if (type === "stderr") return "error";
  if (/(?:^|\.)(?:cancelled|skipped|warn|warning|deprecated)$/i.test(type)) return "warn";
  const text = String(event?.message || "");
  if (/(?:^|\s|:)(error|failed|panic|fatal|exception|timeout)\b/i.test(text)) return "error";
  if (/(?:^|\s|:)(warn(?:ing)?|deprecat|retrying|skipped)\b/i.test(text)) return "warn";
  return "info";
}

function eventNodeClient(event) {
  const data = event?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const field = data.node || data.nodeId || data.taskId || data.task || data.step;
    if (field) return String(field).slice(0, 80);
  }
  return "";
}

function renderRunLogChips(label, entries) {
  if (!entries || !entries.length) return "";
  return `<div class="run-log-chip-row"><span class="muted run-log-chip-label">${esc(label)}</span>${entries
    .map((entry) => `<button type="button" class="run-log-chip" data-filter-kind="${esc(entry.kind)}" data-filter-value="${esc(entry.value)}" aria-pressed="false">${esc(entry.label)}${entry.count ? ` <span class="run-log-chip-count">${esc(entry.count)}</span>` : ""}</button>`)
    .join("")}</div>`;
}

function renderRunLogTotals(totals) {
  if (!totals) return "";
  const items = [
    { label: "events", value: totals.events || 0 },
    { label: "errors", value: totals.errors || 0, kind: "error" },
    { label: "warnings", value: totals.warnings || 0, kind: "warn" },
    { label: "highlights", value: totals.highlights || 0 }
  ];
  return `<dl class="run-log-totals">${items
    .map((item) => `<div class="run-log-total${item.kind ? ` run-log-total-${esc(item.kind)}` : ""}"><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`)
    .join("")}</dl>`;
}

function renderRunLogHighlight(entry, { node = false } = {}) {
  const severity = entry.severity || "info";
  const category = entry.category || "other";
  const nodeChip = node && entry.node ? `<span class="run-log-node-chip" title="node">${esc(entry.node)}</span>` : "";
  return `<li class="run-log-event run-log-sev-${esc(severity)} run-log-cat-${esc(category)}">
    <time>${esc(formatTimestamp(entry.createdAt))}</time>
    <code class="run-log-type">${esc(entry.type)}</code>
    ${nodeChip}
    <span class="run-log-msg">${esc(entry.message || "")}</span>
  </li>`;
}

function renderRunLog(run, events, summary) {
  const totalEvents = Array.isArray(events) ? events.length : 0;
  if (!totalEvents) {
    return `<h3>Timeline</h3><p class="muted">No events yet.</p>`;
  }
  const summaryObj = summary || {};
  const totals = summaryObj.totals || { events: totalEvents, highlights: 0, errors: 0, warnings: 0 };
  const categories = Array.isArray(summaryObj.categories) ? summaryObj.categories : [];
  const severities = Array.isArray(summaryObj.severities) ? summaryObj.severities : [];
  const nodes = Array.isArray(summaryObj.nodes) ? summaryObj.nodes : [];
  const highlights = Array.isArray(summaryObj.highlights) ? summaryObj.highlights : [];
  const defaultCollapsed = new Set(summaryObj.defaultCollapsed || ["noise", "trace"]);
  const categoryChips = categories.map((entry) => ({
    kind: "category",
    value: entry.key,
    label: RUN_LOG_CATEGORY_LABELS[entry.key] || entry.key,
    count: entry.count
  }));
  const severityChips = severities.map((entry) => ({
    kind: "severity",
    value: entry.key,
    label: RUN_LOG_SEVERITY_LABELS[entry.key] || entry.key,
    count: entry.count
  }));
  const nodeChips = nodes.slice(0, 12).map((entry) => ({
    kind: "node",
    value: entry.node,
    label: entry.node,
    count: entry.total
  }));
  const highlightsHtml = highlights.length
    ? `<ol class="run-log-list run-log-highlights">${highlights.map((entry) => renderRunLogHighlight(entry, { node: true })).join("")}</ol>`
    : `<p class="muted">No highlight events yet. Run started/finished, node/approval/agent summaries, and errors/warnings will land here as the run progresses.</p>`;
  const dump = runLogTextDump(events);
  const fullEvents = events.map((event) => {
    const category = eventCategoryClient(event);
    const severity = eventSeverityClient(event);
    const node = eventNodeClient(event);
    return {
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
      category,
      severity,
      node,
      noisy: defaultCollapsed.has(category)
    };
  });
  const noisyCount = fullEvents.filter((e) => e.noisy).length;
  const fullList = fullEvents
    .map(
      (entry) => `<li class="run-log-event run-log-sev-${esc(entry.severity)} run-log-cat-${esc(entry.category)}${entry.noisy ? " run-log-noisy" : ""}" data-category="${esc(entry.category)}" data-severity="${esc(entry.severity)}" data-node="${esc(entry.node || "")}" data-noisy="${entry.noisy ? "1" : "0"}">
        <time>${esc(formatTimestamp(entry.createdAt))}</time>
        <code class="run-log-type">${esc(entry.type)}</code>
        ${entry.node ? `<span class="run-log-node-chip" title="node">${esc(entry.node)}</span>` : ""}
        <span class="run-log-msg">${esc(entry.message || "")}</span>
      </li>`
    )
    .join("");
  const searchControl = `<label class="run-log-search">
    <span class="muted">Search</span>
    <input type="search" id="run-log-search-input" placeholder="filter by text, type, or node" autocomplete="off" />
  </label>`;
  const noisyToggle = noisyCount
    ? `<label class="run-log-noisy-toggle">
        <input type="checkbox" id="run-log-show-noisy" />
        Show ${esc(noisyCount)} collapsed heartbeat/trace event${noisyCount === 1 ? "" : "s"}
      </label>`
    : "";
  return `<div class="run-log-toolbar">
      ${renderRunLogTotals(totals)}
      <div class="run-log-controls">
        <button type="button" class="button" data-copy="${esc(dump)}" title="Copy redacted run log">Copy log</button>
        <a class="button" href="/api/runs/${esc(run.id)}/logs" target="_blank" rel="noopener" title="Open redacted plain-text log">Download text</a>
        <a class="button" href="/api/runs/${esc(run.id)}/log-summary" target="_blank" rel="noopener" title="Open structured log summary JSON">Summary JSON</a>
      </div>
    </div>
    <div class="run-log-filters">
      ${searchControl}
      ${renderRunLogChips("Category", categoryChips)}
      ${renderRunLogChips("Severity", severityChips)}
      ${nodeChips.length ? renderRunLogChips("Node", nodeChips) : ""}
      <button type="button" class="button run-log-clear" id="run-log-clear" title="Clear filters">Clear filters</button>
    </div>
    <section class="run-log-section" data-section="highlights">
      <h3>Key events <span class="muted">(${esc(highlights.length)})</span></h3>
      <p class="muted">Run start/finish, node transitions, approvals, agent summaries, and gate (test/build/commit/push/deploy) markers.</p>
      ${highlightsHtml}
    </section>
    <section class="run-log-section" data-section="full">
      <details class="run-log-full" id="run-log-full">
        <summary>Full timeline <span class="muted">(${esc(totalEvents)} events; noisy categories collapsed by default)</span></summary>
        ${noisyToggle}
        <ol class="run-log-list run-log-full-list" id="run-log-full-list">${fullList}</ol>
      </details>
    </section>`;
}

function bindRunLogFilters(panel) {
  if (!panel) return;
  const list = panel.querySelector("#run-log-full-list");
  const noisyToggle = panel.querySelector("#run-log-show-noisy");
  const searchInput = panel.querySelector("#run-log-search-input");
  const clearBtn = panel.querySelector("#run-log-clear");
  const filters = { categories: new Set(), severities: new Set(), nodes: new Set() };
  const chipKindToFilter = { category: filters.categories, severity: filters.severities, node: filters.nodes };
  const fullDetails = panel.querySelector("#run-log-full");
  const reapply = () => {
    if (!list) return;
    const showNoisy = Boolean(noisyToggle?.checked);
    const query = (searchInput?.value || "").trim().toLowerCase();
    const items = list.querySelectorAll("li.run-log-event");
    items.forEach((li) => {
      const category = li.dataset.category || "";
      const severity = li.dataset.severity || "";
      const node = li.dataset.node || "";
      const noisy = li.dataset.noisy === "1";
      let visible = true;
      if (filters.categories.size && !filters.categories.has(category)) visible = false;
      if (visible && filters.severities.size && !filters.severities.has(severity)) visible = false;
      if (visible && filters.nodes.size && !filters.nodes.has(node)) visible = false;
      if (visible && !showNoisy && noisy && !filters.categories.has(category)) visible = false;
      if (visible && query) {
        const blob = (li.textContent || "").toLowerCase();
        if (!blob.includes(query)) visible = false;
      }
      li.classList.toggle("run-log-hidden", !visible);
    });
    if ((filters.categories.size || filters.severities.size || filters.nodes.size || query) && fullDetails && !fullDetails.open) {
      fullDetails.open = true;
    }
  };
  panel.querySelectorAll(".run-log-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const kind = chip.dataset.filterKind;
      const value = chip.dataset.filterValue;
      const set = chipKindToFilter[kind];
      if (!set) return;
      if (set.has(value)) {
        set.delete(value);
        chip.setAttribute("aria-pressed", "false");
      } else {
        set.add(value);
        chip.setAttribute("aria-pressed", "true");
      }
      reapply();
    });
  });
  noisyToggle?.addEventListener("change", reapply);
  searchInput?.addEventListener("input", reapply);
  clearBtn?.addEventListener("click", () => {
    filters.categories.clear();
    filters.severities.clear();
    filters.nodes.clear();
    panel.querySelectorAll(".run-log-chip").forEach((chip) => chip.setAttribute("aria-pressed", "false"));
    if (searchInput) searchInput.value = "";
    if (noisyToggle) noisyToggle.checked = false;
    reapply();
  });
  reapply();
}

async function renderRunDetail(runId, { focus = "", focusId = "" } = {}) {
  const data = await api(`/api/runs/${runId}`);
  const run = data.run;
  const diagnostics = data.diagnostics || null;
  const folder = runFolderLabel(run);
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const origin = run.originLabel || run.origin?.label || "unknown origin";
  const execution = runExecutionLabel(run);
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
  if (execution) chips.push(`<span class="chip chip-runner">execution ${esc(execution)}</span>`);
  if (run.runnerId) chips.push(`<span class="chip chip-runner">🛠 ${esc(run.runnerId)}</span>`);
  const crumbNav = breadcrumbs([
    { label: "Runs", href: deepLinks.runs() },
    { label: run.capabilityName || slug || "Workflow", href: slug ? deepLinks.workflow(slug) : deepLinks.workflows() },
    { label: run.id, href: deepLinks.run(run.id), title: `Run ${run.id}`, current: true }
  ]);
  content.innerHTML = `${crumbNav}${toolbar(title, `<a class="button" href="${esc(slug ? deepLinks.workflow(slug) : deepLinks.workflows())}">Workflow</a>
      <a class="button" href="${esc(deepLinks.runLogs(run.id))}">Run log</a>
      <a class="button" href="${esc(deepLinks.runArtifacts(run.id))}">Artifacts</a>
      <button id="rerun-run">Re-run</button>
      <button id="cancel-run" class="danger">Cancel</button>`, deepLinks.run(run.id))}
    <p class="run-detail-sub">
      ${status(run.status)}
      ${slug ? `<a class="run-cap-link" href="${esc(deepLinks.workflow(slug))}">${esc(run.capabilityName || slug)}</a>` : ""}
      <span class="run-id-mono" title="Run id">${esc(run.id)}</span>
      <span class="muted">${esc(relativeTime(run.createdAt))}${durStr ? ` · ${esc(durStr)}` : ""}</span>
    </p>
    <p class="run-origin-detail"><strong>Origin</strong> ${esc(origin)}</p>
    <p class="run-detail-desc">${esc(description)}</p>
    ${chips.length ? `<p class="run-detail-chips">${chips.join("")}</p>` : ""}
    ${run.status === "queued" ? renderQueueBanner(run) : ""}
    <p class="run-folder-banner"><span class="run-folder">📁 ${esc(folder)}</span> <span class="muted">— display-only grouping for this run's artifacts &amp; logs</span></p>
    ${focusHint}
    ${renderRunDiagnostics(diagnostics)}
    <section class="split">
      <div class="panel" id="panel-logs">
        <h2>Run log ${shareButton(deepLinks.runLogs(run.id), "Copy share link to this run's log")}</h2>
        <p class="muted">${esc(run.currentStep || "—")}</p>
        ${renderRunLog(run, data.events || [], data.logSummary || null)}
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
    await renderRunDetail(run.id, { focus, focusId });
  });
  $("#rerun-run").addEventListener("click", () => rerunRun(run.id).catch(showError));
  bindCopy();
  bindRunLogFilters($("#panel-logs"));
  // Honor the sub-route by bringing the relevant panel into view.
  if (focus === "logs") $("#panel-logs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (focus === "artifacts") $("#panel-artifacts")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (focus === "artifacts" && focusId) focusElement(`artifact-${focusId}`);
}

function artifactList(artifacts) {
  if (!artifacts.length) return `<p class="muted">No artifacts.</p>`;
  return `<ul class="artifact-list">${artifacts.map((artifact) => `<li id="artifact-${esc(artifact.id)}"><a href="/api/artifacts/${esc(artifact.id)}/download" target="_blank">${esc(artifactDisplayName(artifact))}</a> ${shareButton(deepLinks.artifact(artifact), "Copy share link to this artifact in its run")} <span class="muted">${esc(formatBytes(artifact.sizeBytes))}${artifact.mimeType ? ` · ${esc(artifact.mimeType)}` : ""}</span></li>`).join("")}</ul>`;
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

function approvalFact(label, value) {
  if (!value) return "";
  return `<p><span class="muted">${esc(label)}</span><br>${value}</p>`;
}

function approvalDecisionLabel(approval) {
  const decision = approval?.decision || approval?.status || "";
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  if (decision === "rejected") return "Rejected";
  return decision || "Pending";
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
    content.innerHTML = `${breadcrumbs([
      { label: "Approvals", href: deepLinks.approvals() },
      { label: id, href: deepLinks.approval(id), title: `Approval ${id}`, current: true }
    ])}${toolbar("Approval", `<a class="button" href="${esc(deepLinks.approvals())}">All approvals</a>`, deepLinks.approval(id))}
      <section class="panel"><p class="muted">${esc(error.message)}</p></section>`;
    return;
  }
  const context = approvalContext(approval);
  const workflow = context.workflow;
  const run = context.run;
  const project = context.project || {};
  const canResolve = approval.status === "pending";
  const actions = `<a class="button" href="${esc(deepLinks.approvals())}">All approvals</a>${run ? ` <a class="button" href="${esc(run.deepLink)}">Open run</a>` : ""}`;
  const crumbNav = breadcrumbs([
    { label: "Approvals", href: deepLinks.approvals() },
    workflow?.deepLink ? { label: approvalWorkflowLabel(approval), href: workflow.deepLink } : null,
    { label: approval.id, href: deepLinks.approval(approval.id), title: approval.title || `Approval ${approval.id}`, current: true }
  ]);
  content.innerHTML = `${crumbNav}${toolbar(approval.title, actions, deepLinks.approval(approval.id))}
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
          ${approvalFact("Requested by", esc(context.requestedBy || approval.requestedBy || "workflow"))}
          ${approvalFact("Workflow", workflow?.deepLink ? `<a href="${esc(workflow.deepLink)}">${esc(approvalWorkflowLabel(approval))}</a>` : esc(approvalWorkflowLabel(approval)))}
          ${approvalFact("Project / repo / path", project.display ? esc(project.display) : "")}
          ${approvalFact("Target branch", context.targetBranch ? esc(context.targetBranch) : context.branch ? esc(context.branch) : "")}
          ${approvalDeployLine(approval)}
          ${approvalFact("Approval ID", `<span class="run-id-mono">${esc(approval.id)}</span>`)}
          ${approvalFact("Run", approvalRunLink(approval) || `<span class="muted">No linked run</span>`)}
        </div>
        ${context.proposedChange ? `<h3>Proposed change</h3><p class="approval-proposed-change">${esc(context.proposedChange)}</p>` : ""}
        ${run ? `<h3>Linked run</h3>
          <p><strong>${esc(run.title || approval.runId)}</strong> ${status(run.status)}</p>
          <p class="muted">${esc(run.description || run.currentStep || "")}</p>` : ""}
        <h3>Proposed action</h3>
        <p class="notice">${esc(context.proposedAction || context.whatHappensIfApproved || "Approving marks this approval approved.")}</p>
        <h3>Decision outcomes</h3>
        <p class="muted">${esc(context.whatHappensIfApproved || "Approving marks this approval approved.")}</p>
        <p class="muted">${esc(context.whatHappensIfChangesRequested || "Requesting changes records changes_requested.")}</p>
        <p class="muted">${esc(context.whatHappensIfRejected || "Rejecting marks this approval rejected.")}</p>
        ${canResolve ? `<div class="approval-decision">
          <label>Decision note<textarea id="approval-comment" placeholder="Optional for approve/reject. For request changes, describe the new inputs or changes needed."></textarea></label>
          <div class="toolbar-actions">
            <button id="approval-approve" class="primary">Approve</button>
            <button id="approval-request-changes" class="warning">Request changes</button>
            <button id="approval-reject" class="danger">Reject</button>
          </div>
        </div>` : `<p class="approval-resolved"><strong>${esc(approvalDecisionLabel(approval))}</strong><br><span class="muted">Resolved by ${esc(approval.resolvedBy || "unknown")} at ${esc(approval.resolvedAt || "unknown")}${approval.comment ? `: ${esc(approval.comment)}` : ""}</span></p>`}
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
    $("#approval-request-changes").addEventListener("click", () => resolveApproval(approval.id, "request-changes", { rerender: "detail" }));
    $("#approval-reject").addEventListener("click", () => resolveApproval(approval.id, "reject", { rerender: "detail" }));
  }
  bindCopy();
}

async function resolveApproval(id, decision, { rerender = "list" } = {}) {
  const defaultComments = {
    approve: "Approved from Web Hub",
    reject: "Rejected from Web Hub",
    "request-changes": "Changes requested from Web Hub"
  };
  const comment = $("#approval-comment")?.value?.trim() || defaultComments[decision] || "Resolved from Web Hub";
  await api(`/api/approvals/${id}/${decision}`, { method: "POST", body: { comment } });
  toast(decision === "approve" ? "Approval granted" : decision === "request-changes" ? "Changes requested" : "Approval rejected", "ok");
  if (rerender === "detail") return renderApprovalDetail(id);
  if (rerender === "none") return null;
  return renderApprovals();
}

async function rerunRun(id) {
  const result = await api(`/api/runs/${id}/rerun`, { method: "POST", body: {} });
  toast("Re-run queued", "ok");
  location.hash = deepLinks.run(result.run.id).slice(1);
  state.view = `runs/${result.run.id}`;
  await render();
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

// Render a "3 / 4" style capacity badge plus a small slot row showing
// filled vs free job slots — gives the operator an at-a-glance read of
// whether the VPS pool is saturated.
function runnerCapacityCell(runner) {
  const capacity = Number(runner.capacity || 1);
  const active = Number(runner.activeRuns || 0);
  const slots = [];
  for (let i = 0; i < capacity; i += 1) {
    slots.push(`<span class="runner-slot ${i < active ? "filled" : "free"}" aria-hidden="true"></span>`);
  }
  const saturated = capacity > 0 && active >= capacity;
  return `<span class="runner-capacity ${saturated ? "saturated" : ""}" title="${active} active of ${capacity} slots">
    <span class="runner-capacity-count">${esc(active)} / ${esc(capacity)}</span>
    <span class="runner-slots" aria-label="${active} of ${capacity} slots filled">${slots.join("")}</span>
  </span>`;
}

function renderRunnerPoolSummary(pool) {
  if (!pool) return "";
  const queued = pool.queued || 0;
  const capacity = pool.totalCapacity || 0;
  const active = pool.totalActive || 0;
  const available = pool.availableSlots != null ? pool.availableSlots : Math.max(0, capacity - active);
  const queueChip = queued
    ? `<span class="chip chip-queue" title="Runs waiting for a free runner slot">⏳ ${esc(queued)} queued</span>`
    : `<span class="chip chip-queue empty" title="Queue is empty">⏳ queue empty</span>`;
  const capacityChip = `<span class="chip chip-runner" title="Active slots / total capacity across online runners">🛠 ${esc(active)} / ${esc(capacity)} slots</span>`;
  const availableChip = `<span class="chip ${available ? "chip-branch" : "chip-version"}" title="Free slots across the pool">🟢 ${esc(available)} free</span>`;
  return `<p class="runner-pool-summary">${queueChip}${capacityChip}${availableChip}</p>`;
}

async function renderRunners() {
  const data = await api("/api/runners");
  const pool = data.pool || null;
  const summary = renderRunnerPoolSummary(pool);
  // Heartbeat freshness drives the dot color: <30s green, <2m amber, else red.
  // We render the absolute timestamp as a tooltip so log forensics still work.
  const heartbeatCell = (runner) => {
    const iso = runner.lastHeartbeatAt;
    if (!iso) return `<span class="muted">never</span>`;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return esc(iso);
    const ageMs = Date.now() - t;
    const tone = ageMs <= 30_000 ? "ok" : ageMs <= 120_000 ? "warn" : "danger";
    return `<span class="hb-cell hb-${tone}" title="${esc(iso)}">${esc(relativeTime(iso))}</span>`;
  };
  content.innerHTML = `${toolbar("Runners", "", deepLinks.runners())}<section class="panel">
    ${summary}
    ${data.runners.length ? `<table class="table runners-table"><thead><tr><th>Name</th><th>Status</th><th>Capacity</th><th>Version</th><th>OS · host</th><th>Tags</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${data.runners.map((runner) => `<tr id="runner-row-${esc(runner.id)}"><td data-label="Name">${esc(runner.name)}<br><span class="muted">${esc(runner.id)}</span></td><td data-label="Status">${status(runner.online ? "online" : "offline")}</td><td data-label="Capacity">${runnerCapacityCell(runner)}</td><td data-label="Version">${runner.version ? `<code>${esc(runner.version)}</code>` : '<span class="muted">unknown</span>'}</td><td data-label="OS · host">${(runner.platform || runner.hostname) ? `${esc(runner.platform || "?")} · <span class="muted">${esc(runner.hostname || "?")}</span>` : '<span class="muted">—</span>'}</td><td data-label="Tags">${esc((runner.tags || []).join(", "))}</td><td data-label="Last seen">${heartbeatCell(runner)}</td><td data-label="Actions"><button class="button" data-runner-ping="${esc(runner.id)}" title="Refresh heartbeat reading">Send test ping</button> <button class="button" data-runner-toggle="${esc(runner.id)}" aria-expanded="false">Details</button></td></tr>
      <tr class="runner-detail-row hidden" id="runner-detail-${esc(runner.id)}"><td colspan="8"><dl class="runner-detail-grid"><dt>Runner ID</dt><dd><code>${esc(runner.id)}</code></dd><dt>Hostname</dt><dd>${esc(runner.hostname || "—")}</dd><dt>Platform</dt><dd>${esc(runner.platform || "—")}</dd><dt>Version</dt><dd>${esc(runner.version || "—")}</dd><dt>Tags</dt><dd>${esc((runner.tags || []).join(", ") || "—")}</dd><dt>Created</dt><dd>${esc(runner.createdAt || "—")}</dd><dt>Last heartbeat</dt><dd>${esc(runner.lastHeartbeatAt || "never")}</dd><dt>Current run</dt><dd>${runner.currentRunId ? `<a href="${esc(deepLinks.run(runner.currentRunId))}">${esc(runner.currentRunId)}</a>` : "<span class=\"muted\">idle</span>"}</dd></dl></td></tr>`).join("")}
    </tbody></table>` : empty("No runners connected.", "Start one with <code>smithers-hub-runner</code> using a token that has the runner scope. Set <code>SMITHERS_RUNNER_CONCURRENCY=4</code> on a dedicated pool host for ~4 concurrent jobs.")}
  </section>`;
  document.querySelectorAll("[data-runner-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.runnerToggle;
      const row = document.getElementById(`runner-detail-${id}`);
      if (!row) return;
      const open = !row.classList.toggle("hidden");
      button.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
  document.querySelectorAll("[data-runner-ping]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.runnerPing;
      button.disabled = true;
      try {
        // Re-fetch the runner list so the heartbeat freshness re-paints with
        // the latest server-side reading. No bespoke "ping" endpoint exists —
        // re-rendering serves the same observable purpose.
        await renderRunners();
        toast(`Refreshed heartbeat for ${id}`, "ok");
      } catch (error) {
        toast(error.message || "Refresh failed", "error");
        button.disabled = false;
      }
    });
  });
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
    $("#created-token").innerHTML = `<h3>Token created</h3><p class="muted">This value is shown once. Copy it now — hidden by default to keep it out of screenshots.</p>
      ${secretInput("token-value", created.token.token, { label: "New token" })}`;
    bindSecretToggles();
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
        toast("Token revoked", "ok");
      } catch (error) {
        toast(error.message || "Revoke failed", "error");
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
  const mcpSnippet = `smithers-hub mcp install --all`;
  const cliSnippet = `smithers-hub login --url ${origin}\nsmithers-hub menu        # then: smithers-hub run hello`;
  const apiSnippet = `curl -H "authorization: Bearer $TOKEN" ${origin}/api/menu`;
  const runnerSnippet = `SMITHERS_HUB_URL=${origin} \\\nSMITHERS_HUB_TOKEN=shub_... \\\nSMITHERS_RUNNER_TAGS=linux,node,git,shell,web,smithers \\\nsmithers-hub-runner`;
  content.innerHTML = `${toolbar("Connect an Agent or Teammate", "", deepLinks.connect())}
    <section class="panel">
      <h2>Connect agents</h2>
      <p class="muted">Now that your first capability has run, wire any of these channels. Bin names match the current build — copy and paste verbatim.</p>
      <div class="setup-grid">
        <article class="setup-step">
          <h3>MCP</h3>
          <p class="muted">Auto-configure every detected AI client (Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code).</p>
          <div class="copy-row"><input readonly value="${esc(mcpSnippet)}"><button data-copy="${esc(mcpSnippet)}">Copy</button></div>
        </article>
        <article class="setup-step">
          <h3>CLI</h3>
          <p class="muted">Authenticate, then show the next-action menu and run <code>hello</code>.</p>
          <pre class="json">${esc(cliSnippet)}</pre>
        </article>
        <article class="setup-step">
          <h3>HTTP API</h3>
          <p class="muted">Bearer-token API; mirrors every CLI/MCP action. Discovery at <code>/llms.txt</code> + <code>/openapi.json</code>.</p>
          <div class="copy-row"><input readonly value="${esc(apiSnippet)}"><button data-copy="${esc(apiSnippet)}">Copy</button></div>
        </article>
        <article class="setup-step">
          <h3>Runner pool</h3>
          <p class="muted">Bring more capacity online — one runner process per host.</p>
          <pre class="json">${esc(runnerSnippet)}</pre>
        </article>
      </div>
    </section>
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
        <p class="muted">Token (shown once) — they paste it when the installer asks. Hidden by default to keep it out of screenshots:</p>
        ${secretInput("invite-token", data.token.token, { label: "Teammate token" })}
        <p class="muted">Install command:</p>
        <div class="copy-row"><input id="invite-cmd" readonly value="${esc(installCmd)}"><button data-copy-el="invite-cmd">Copy</button></div>
        <p class="muted">Then they run <code>smithers-hub mcp install --all</code>. Revoke anytime under Tokens.</p>`;
      bindCopy();
      bindSecretToggles();
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
