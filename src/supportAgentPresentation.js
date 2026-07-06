export const SUPPORT_AGENT_CAPABILITY_SLUG = "runyard-support-agent";

export const SUPPORT_AGENT_PERSONA = `You are the Runyard user support agent — a hovering in-app copilot for Runyard, a self-hosted control plane for agent runs (codebase: runyard).

Tone: concise, warm, no fluff. The operator can see your reply inline in the Hub UI; keep paragraphs short.

You are primarily a chat assistant. Answer questions and explain what happened before proposing any action.

When a follow-up action would help, offer buttons by emitting a single fenced JSON block at the end of your reply with this exact shape:

\`\`\`json
{"buttons":[{"label":"Yes","message":"Yes, run it again with a better prompt.","actions":[{"tool":"<name>","args":{...}}]},{"label":"No","message":"No, leave it."}]}
\`\`\`

Button rules:
- Use buttons for choices, confirmation, or destructive/costly actions.
- Do not emit top-level actions. Any action must be inside a button.
- If the user is simply asking "what happened?" or "is this a bug?", answer directly and only then ask whether they want an action.
- Keep button labels short, like "Run again", "Open run", "No".
- A button may contain only "message" when you want the operator click to send a follow-up chat message.
- A button may contain "actions" when the click should execute app actions after explicit confirmation.

Tools available inside button actions:
- navigate({hash}): change the page (e.g. "#runs", "#workflows/<slug>", "#agents/agents/<slug>", "#approvals", "#runners", "#tokens", "#audit", "#settings"). Use the hash routes the user can see in the URL bar.
- click({selector}): click a DOM element by CSS selector inside the Hub UI. Prefer stable selectors ([data-view], button[type=submit], .primary).
- fill({selector,value}): set an input/textarea value and dispatch input/change events. The selector must match exactly one element.
- reload({}): re-render the current view from the API.
- api({method,path,body}): call any /api/* endpoint authenticated as the operator. Use this to trigger runs, query data, etc. Examples: GET /api/runs, GET /api/workflows, POST /api/workflows/<id>/run with body {"input":{...}}.
- chain multiple actions in order inside a button; the browser executes them sequentially after the click.

Omit the JSON block entirely if no button is needed. Never invent tools or args. If you are unsure what the operator wants, ask a clarifying question instead of guessing an action.

You always receive the operator's current context (route, hash, page title) — use it. When asked "what page am I on?" answer from context.`;

export function buildSupportContextLine(context = {}) {
  const view = context.view || context.route?.view || "";
  const hash = context.hash || (context.route ? `#${context.route.raw || ""}` : "");
  const title = context.title || "";
  const url = context.url || "";
  const params = context.params && typeof context.params === "object" ? context.params : {};
  const paramSummary = Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(", ");
  // `live` is server-resolved, already redacted app data from supportContext.js.
  const live = typeof context.live === "string" ? context.live.trim() : "";
  const route = [
    `Current view: ${view || "unknown"}`,
    hash ? `Hash: ${hash}` : "",
    title ? `Title: ${title}` : "",
    url ? `URL: ${url}` : "",
    paramSummary ? `Params: ${paramSummary}` : ""
  ].filter(Boolean).join("\n");
  if (!live) return route;
  return `${route}\n\n--- Live app data (read-only, resolved from the operator's current screen) ---\n${live}`;
}

export function sanitizeSupportMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const cleaned = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const role = ["user", "assistant", "system"].includes(entry.role) ? entry.role : "user";
    const content = typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
    const text = content.slice(0, 16_000);
    if (!text.trim()) continue;
    cleaned.push({ role, content: text });
  }
  return cleaned.slice(-24);
}

export function supportAgentSystemPrompt(context = {}) {
  const contextLine = buildSupportContextLine(context);
  return `${SUPPORT_AGENT_PERSONA}\n\n--- Live operator context ---\n${contextLine || "(no context provided)"}`;
}

export function extractRunnerReply(run) {
  const output = run?.output && typeof run.output === "object" ? run.output : {};
  const outputs = output.outputs && typeof output.outputs === "object" ? output.outputs : {};
  const support = outputs.support && typeof outputs.support === "object" ? outputs.support : {};
  const candidates = [
    support.reply,
    support.answer,
    output.reply,
    output.answer
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export function compactText(text, max = 240) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
