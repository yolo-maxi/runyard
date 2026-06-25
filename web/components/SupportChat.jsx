import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../lib/api.js";
import { useHashRoute, deepLinks, navigate } from "../lib/router.js";
import { useLocalStorage } from "../lib/storage.js";
import { toast } from "../lib/toast.js";
import { relativeTime } from "../lib/format.js";

// Self-contained Support Chat copilot. Ported 1:1 from the legacy
// public/legacy-app.js supportChatState / bindSupportChat machinery into a
// single React component that renders BOTH the floating FAB and the panel and
// owns its own open/closed state. Mounted once inside the authenticated shell.
//
// Class names mirror the legacy index.html / app.js markup exactly so the
// existing public/styles.css rules apply unchanged.

const SUPPORT_CHAT_STORAGE_KEY = "runyard.supportChat.v1";
const SUPPORT_CHAT_MAX_TABS = 8;
const SUPPORT_CHAT_MAX_TURNS = 24;

// Inline sparkle SVG for the FAB — not the emoji, so it renders identically on
// every platform (copied from the legacy index.html).
const sparkleIcon = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="M12 8.5 13 11l2.5 1-2.5 1-1 2.5-1-2.5L8.5 12 11 11z" />
  </svg>
);

function newChatId() {
  return `c_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function newMsgId() {
  return `m_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function emptyChat(seedTitle = "") {
  return {
    id: newChatId(),
    title: seedTitle || "New chat",
    messages: [],
    createdAt: new Date().toISOString()
  };
}

// Sanitize whatever came back from localStorage into a usable {tabs, activeId}.
function normalizeStored(parsed) {
  let tabs = [];
  let activeId = null;
  if (parsed && Array.isArray(parsed.tabs)) {
    tabs = parsed.tabs.filter((tab) => tab && typeof tab === "object" && tab.id);
    activeId = parsed.activeId || tabs[0]?.id || null;
  }
  if (!tabs.length) {
    const first = emptyChat();
    tabs = [first];
    activeId = first.id;
  }
  if (!activeId || !tabs.find((tab) => tab.id === activeId)) {
    activeId = tabs[0].id;
  }
  return { tabs, activeId };
}

// ---- Context-aware quick-reply chips ---------------------------------------
// Reads the live route so suggestions on a failed run differ from the Runs
// list, a workflow page, or Approvals. Ported 1:1 from supportQuickReplies().
function supportQuickReplies(route) {
  const view = route.view;
  const seg = route.segments;
  if (view === "runs" && seg[1]) {
    return ["Why did this run fail?", "Is this a bug in the runner?", "Explain this run", "Re-run with a better prompt"];
  }
  if (view === "home" || view === "runs" || view === "dashboard") {
    return ["What's broken?", "Summarize today's runs", "Show me failing runs"];
  }
  if ((view === "workflows" || view === "capabilities") && seg[1]) {
    return ["What does this workflow do?", "Show recent runs", "How do I run this?"];
  }
  if (view === "workflows" || view === "capabilities") {
    return ["Which workflow should I use?", "What can I run here?"];
  }
  if (view === "approvals") return ["What needs my approval?", "Explain this approval"];
  if (view === "runners") return ["Are my runners healthy?", "Why is a run stuck in the queue?"];
  if (view === "agents" || view === "skills" || view === "knowledge") return ["What are agents for?", "What page am I on?"];
  return ["What page am I on?", "What can you do?"];
}

// ---- Reply parsing ----------------------------------------------------------
// Normalize the agent's optional action buttons (ported from
// normalizeSupportButtons()). Either an explicit `buttons` array or a legacy
// `actions` array (wrapped into a yes/no pair).
function normalizeSupportButtons(payload) {
  const out = [];
  const buttons = Array.isArray(payload?.buttons) ? payload.buttons : [];
  for (const entry of buttons.slice(0, 4)) {
    if (!entry || typeof entry !== "object") continue;
    const label = String(entry.label || entry.title || "").trim().slice(0, 32);
    if (!label) continue;
    const message = String(entry.message || entry.prompt || label).trim().slice(0, 2000);
    const actions = Array.isArray(entry.actions) ? entry.actions.slice(0, 6) : [];
    out.push({
      label,
      message,
      actions,
      tone: /^(no|cancel|stop|leave)/i.test(label) ? "secondary" : "primary"
    });
  }
  const legacyActions = Array.isArray(payload?.actions) ? payload.actions.slice(0, 6) : [];
  if (!out.length && legacyActions.length) {
    out.push({ label: "Do it", message: "Do it.", actions: legacyActions, tone: "primary" });
    out.push({ label: "No", message: "No, leave it.", actions: [], tone: "secondary" });
  }
  return out;
}

// Pulls a trailing ```json {"buttons":[...]}``` block (or bare trailing JSON
// object) out of a reply and returns { text, buttons }. Ported 1:1 from
// parseAgentResponse().
function parseAgentResponse(reply) {
  const text = String(reply || "");
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```\s*$/i);
  let payload = null;
  let head = text;
  if (fence) {
    try {
      payload = JSON.parse(fence[1]);
      head = text.slice(0, fence.index).trim();
    } catch {
      /* fall through */
    }
  }
  if (!payload) {
    const brace = text.lastIndexOf("{");
    if (brace > -1) {
      const tail = text.slice(brace).trim();
      try {
        const candidate = JSON.parse(tail);
        if (candidate && (Array.isArray(candidate.buttons) || Array.isArray(candidate.actions))) {
          payload = candidate;
          head = text.slice(0, brace).trim();
        }
      } catch {
        /* not JSON */
      }
    }
  }
  const buttons = normalizeSupportButtons(payload);
  const replyText = payload?.reply ? String(payload.reply) : head || "";
  return { text: replyText.trim(), buttons };
}

// ---- Agent actions (reply-button side effects) ------------------------------
// Ported from executeAgentAction(). navigate/api are reused from the React
// libs; click/fill/reload fall back to imperative DOM ops just like the legacy
// implementation (the agent occasionally drives the page directly).
async function executeAgentAction(action) {
  const tool = String(action?.tool || "").toLowerCase();
  const args = action?.args || {};
  if (tool === "navigate") {
    const hash = String(args.hash || args.to || "");
    if (!hash) return { ok: false, summary: "navigate requires { hash }" };
    navigate(hash);
    return { ok: true, summary: `Navigated to ${hash}` };
  }
  if (tool === "click") {
    const selector = String(args.selector || "");
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { ok: false, summary: `click: no element matched ${selector}` };
    el.click();
    return { ok: true, summary: `Clicked ${selector}` };
  }
  if (tool === "fill") {
    const selector = String(args.selector || "");
    const value = args.value == null ? "" : String(args.value);
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { ok: false, summary: `fill: no element matched ${selector}` };
    if ("value" in el) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, summary: `Filled ${selector}` };
    }
    el.textContent = value;
    return { ok: true, summary: `Set text on ${selector}` };
  }
  if (tool === "reload" || tool === "refresh") {
    // The legacy app re-rendered its imperative view here. The React app
    // re-renders reactively, so a manual hashchange nudges any view to re-pull.
    if (typeof window !== "undefined") window.dispatchEvent(new HashChangeEvent("hashchange"));
    return { ok: true, summary: "Re-rendered current view" };
  }
  if (tool === "api") {
    const method = String(args.method || "GET").toUpperCase();
    const apiPath = String(args.path || "");
    if (!apiPath.startsWith("/api/")) return { ok: false, summary: "api: path must start with /api/" };
    try {
      const data = await api(apiPath, {
        method,
        body: args.body !== undefined ? args.body : undefined
      });
      const preview = JSON.stringify(data).slice(0, 600);
      return { ok: true, summary: `${method} ${apiPath} → ${preview}` };
    } catch (error) {
      return { ok: false, summary: `${method} ${apiPath} failed: ${error.message}` };
    }
  }
  return { ok: false, summary: `Unknown tool: ${tool}` };
}

// ---- Time formatting --------------------------------------------------------
// Absolute local time for the grouped time separator (ported from
// formatChatGroupTime()).
function formatChatGroupTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date} · ${time}`;
}

// ---- Sub-components ---------------------------------------------------------

function SupportButtons({ message, onActivate }) {
  const buttons = Array.isArray(message.buttons) ? message.buttons : [];
  const available = buttons
    .map((button, index) => ({ button, index }))
    .filter(({ button }) => button && !button.used && button.label);
  if (!available.length) return null;
  return (
    <div className="support-chat-choices">
      {available.map(({ button, index }) => {
        const tone = button.tone === "secondary" ? "secondary" : "primary";
        return (
          <button
            key={index}
            type="button"
            className={`support-chat-choice support-chat-choice--${tone}`}
            onClick={() => onActivate(message.id, index)}
          >
            {button.label}
          </button>
        );
      })}
    </div>
  );
}

function MessageBubble({ message, showSeparator, senderChanged, onActivate }) {
  const role = message.role || "assistant";
  // System and tool bubbles are transient/diagnostic — no wrapper, timestamp,
  // separator, or sender-change treatment.
  if (role === "tool") {
    return <div className="support-chat-msg tool">{message.content}</div>;
  }
  if (role === "system") {
    return <div className="support-chat-msg system">{message.content}</div>;
  }
  const stamp = message.at ? relativeTime(message.at) : "";
  const meta = stamp ? (
    <div className="support-chat-msg-meta muted" title={message.at || ""}>
      {stamp}
    </div>
  ) : null;
  const sepLabel = showSeparator && message.at ? formatChatGroupTime(message.at) : "";
  const separator = sepLabel ? (
    <div className="support-chat-time-separator" role="separator" aria-label={message.at}>
      <span>{sepLabel}</span>
    </div>
  ) : null;
  const senderChange = senderChanged ? " support-chat-msg-wrap--sender-change" : "";
  if (message.error) {
    return (
      <>
        {separator}
        <div className={`support-chat-msg-wrap support-chat-msg-wrap--error${senderChange}`}>
          <div className="support-chat-msg error">{message.content}</div>
          {meta}
          <SupportButtons message={message} onActivate={onActivate} />
        </div>
      </>
    );
  }
  return (
    <>
      {separator}
      <div className={`support-chat-msg-wrap support-chat-msg-wrap--${role}${senderChange}`}>
        <div className={`support-chat-msg ${role}`}>{message.content}</div>
        {meta}
        <SupportButtons message={message} onActivate={onActivate} />
      </div>
    </>
  );
}

// Renders the conversation body — empty-state starters or the message thread
// plus the in-flight typing indicator. Ported from renderSupportChat()'s body.
function ChatBody({ tab, busy, onStarter, onActivate, bodyRef }) {
  if (!tab) return <div className="support-chat-body" aria-live="polite" ref={bodyRef} />;

  if (!tab.messages.length) {
    const starters = [
      "Open the most recent failed run",
      "Summarize today's runs",
      "Why did the last capability fail?"
    ];
    return (
      <div className="support-chat-body" aria-live="polite" ref={bodyRef}>
        <div className="support-chat-empty">
          <strong>Runyard support agent</strong>
          <div className="support-chat-empty-lead">Ask in natural language. The agent sees the page you're on.</div>
          <ul className="support-chat-starters" aria-label="Starter prompts">
            {starters.map((prompt) => (
              <li key={prompt}>
                <button type="button" className="support-chat-starter" onClick={() => onStarter(prompt)}>
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {busy ? <TypingIndicator /> : null}
      </div>
    );
  }

  // Track the previous user/assistant message so each bubble can decide when to
  // emit a time separator (gap > 5 min or first message) and flag a sender
  // change. tool/system messages are diagnostic noise and don't reset state.
  let prevUserlikeAt = null;
  let prevUserlikeRole = null;
  return (
    <div className="support-chat-body" aria-live="polite" ref={bodyRef}>
      {tab.messages.map((message) => {
        const role = message.role || "assistant";
        const isMeta = role === "tool" || role === "system";
        let showSeparator = false;
        let senderChanged = false;
        if (!isMeta) {
          const at = message.at || null;
          const gapMs = prevUserlikeAt && at ? Date.parse(at) - Date.parse(prevUserlikeAt) : Infinity;
          showSeparator = !prevUserlikeAt || (Number.isFinite(gapMs) && gapMs > 5 * 60_000);
          senderChanged = prevUserlikeRole != null && prevUserlikeRole !== role;
          prevUserlikeAt = at || prevUserlikeAt;
          prevUserlikeRole = role;
        }
        return (
          <MessageBubble
            key={message.id}
            message={message}
            showSeparator={showSeparator}
            senderChanged={senderChanged}
            onActivate={onActivate}
          />
        );
      })}
      {busy ? <TypingIndicator /> : null}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="support-chat-msg-wrap support-chat-msg-wrap--assistant support-chat-typing-wrap">
      <div className="support-chat-msg assistant support-chat-typing" role="status" aria-label="Assistant is thinking">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

// ---- Main component ---------------------------------------------------------

export function SupportChat({ me }) {
  const route = useHashRoute();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  // Transient status (Thinking… / errors). When falsy, the persistent
  // offline-warning banner is shown instead (see statusMessage below).
  const [transientStatus, setTransientStatus] = useState(null); // { message, tone } | null

  // Persisted multi-tab sessions. The hook hydrates from / writes to the same
  // "runyard.supportChat.v1" key the legacy app used. We normalize the raw
  // stored value once so we always have at least one tab + a valid activeId.
  const [stored, setStored] = useLocalStorage(SUPPORT_CHAT_STORAGE_KEY, null);
  const { tabs, activeId } = useMemo(() => normalizeStored(stored), [stored]);

  const inputRef = useRef(null);
  const bodyRef = useRef(null);
  const overflowRef = useRef(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) || null, [tabs, activeId]);

  // Cap stored history per tab so localStorage stays small (matches the legacy
  // persistSupportChat slice(-40)).
  const commit = useCallback(
    (nextTabs, nextActiveId) => {
      setStored({
        tabs: nextTabs.map((tab) => ({ ...tab, messages: tab.messages.slice(-40) })),
        activeId: nextActiveId
      });
    },
    [setStored]
  );

  // Persistent status text: the offline warning when the agent isn't
  // configured, otherwise empty. Ported from persistentSupportStatus().
  const persistentStatus = configured
    ? ""
    : "Support agent is offline — install the Runyard support workflow and keep a smithers runner online.";
  const status = transientStatus
    ? transientStatus
    : persistentStatus
      ? { message: persistentStatus, tone: "warn" }
      : { message: "", tone: "info" };

  // ---- Effects -------------------------------------------------------------

  // On mount: GET /api/chat/status to decide if the agent is configured.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api("/api/chat/status");
        if (cancelled) return;
        setConfigured(Boolean(info?.configured));
      } catch {
        if (cancelled) return;
        setConfigured(false);
        setTransientStatus({ message: "Support agent status unavailable.", tone: "warn" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global hotkey: Ctrl+/ (or Cmd+/) toggles the chat.
  useEffect(() => {
    function onKey(event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Click outside / Esc closes the overflow menu so it doesn't trap the user.
  useEffect(() => {
    if (!overflowOpen) return undefined;
    function onClick(event) {
      if (overflowRef.current && !overflowRef.current.contains(event.target)) setOverflowOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOverflowOpen(false);
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

  // When the panel opens (or the thread/busy state changes), restore the active
  // tab's draft, focus the input, and pin the body to the bottom.
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input && !input.value && activeTab?.draft) input.value = activeTab.draft;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId]);

  // Keep the thread pinned to the bottom as messages / typing indicator change.
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [open, activeTab?.messages, busy]);

  // ---- Tab management ------------------------------------------------------

  const setActiveSupportTab = useCallback(
    (id) => {
      if (!tabs.find((tab) => tab.id === id)) return;
      commit(tabs, id);
      // Reset the live textarea; the open-effect restores the new tab's draft.
      if (inputRef.current) inputRef.current.value = "";
    },
    [tabs, commit]
  );

  const addSupportTab = useCallback(() => {
    if (tabs.length >= SUPPORT_CHAT_MAX_TABS) {
      toast(`Chat tab limit (${SUPPORT_CHAT_MAX_TABS}) reached`, "error");
      return;
    }
    const tab = emptyChat();
    commit([...tabs, tab], tab.id);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [tabs, commit]);

  const resetActiveSupportTab = useCallback(() => {
    if (!activeTab) return;
    const nextTabs = tabs.map((tab) =>
      tab.id === activeId ? { ...tab, messages: [], title: "New chat", createdAt: new Date().toISOString() } : tab
    );
    commit(nextTabs, activeId);
  }, [tabs, activeId, activeTab, commit]);

  // Wipes ALL chat tabs (destructive across the operator's whole history) —
  // confirms first, then resets to a single fresh tab. Ported from
  // clearAllSupportChats().
  const clearAllSupportChats = useCallback(() => {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(
        "Clear the entire support conversation? This removes every chat tab and cannot be undone."
      );
      if (!ok) return;
    }
    const fresh = emptyChat();
    commit([fresh], fresh.id);
    toast("Conversation cleared", "ok");
  }, [commit]);

  const closeSupportTab = useCallback(
    (id) => {
      const idx = tabs.findIndex((tab) => tab.id === id);
      if (idx < 0) return;
      const nextTabs = tabs.slice();
      nextTabs.splice(idx, 1);
      let nextActiveId = activeId;
      if (!nextTabs.length) {
        const fresh = emptyChat();
        nextTabs.push(fresh);
        nextActiveId = fresh.id;
      } else if (activeId === id) {
        nextActiveId = nextTabs[Math.min(idx, nextTabs.length - 1)].id;
      }
      commit(nextTabs, nextActiveId);
    },
    [tabs, activeId, commit]
  );

  // ---- Context payload -----------------------------------------------------
  // Built from the current route — the agent sees the page you're on. Ported
  // from describeContext(); reads the route reactively so it's always live.
  const describeContext = useCallback(() => {
    const params = {};
    route.params.forEach((value, key) => {
      params[key] = value;
    });
    return {
      view: route.view,
      hash: typeof location !== "undefined" ? location.hash || "" : "",
      segments: route.segments,
      params,
      title: typeof document !== "undefined" ? document.title : "",
      url: typeof location !== "undefined" ? location.href : "",
      online: typeof navigator !== "undefined" ? navigator.onLine : true,
      me: me?.name || me?.id || ""
    };
  }, [route, me]);

  // ---- Messaging -----------------------------------------------------------

  // Append a message to a given tab id and commit. Returns the next tabs array
  // so callers can chain. `busyRef`-free: state updates drive re-render.
  const appendMessage = useCallback(
    (tabsArr, tabId, role, content, extras = {}) => {
      const next = tabsArr.map((tab) => {
        if (tab.id !== tabId) return tab;
        const messages = tab.messages.concat({
          id: newMsgId(),
          role,
          content: String(content ?? ""),
          at: new Date().toISOString(),
          ...extras
        });
        // Title the tab from the first user prompt so the strip stays scannable.
        let title = tab.title;
        if (role === "user" && (tab.title === "New chat" || !tab.title)) {
          title = content.split(/\n/)[0].slice(0, 40).trim() || "Chat";
        }
        return { ...tab, messages, title };
      });
      return next;
    },
    []
  );

  const sendSupportMessage = useCallback(
    async (text) => {
      if (!activeTab || busy) return;
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      const tabId = activeTab.id;

      // Optimistic user bubble + clear the saved draft for this tab.
      let working = appendMessage(tabs, tabId, "user", trimmed);
      working = working.map((tab) => (tab.id === tabId ? { ...tab, draft: "" } : tab));
      commit(working, activeId);
      setBusy(true);
      setTransientStatus({ message: "Thinking…", tone: "info" });

      try {
        const tab = working.find((t) => t.id === tabId);
        const history = tab.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-SUPPORT_CHAT_MAX_TURNS)
          .map((m) => ({ role: m.role, content: m.content }));
        const response = await api("/api/chat", {
          method: "POST",
          body: { messages: history, context: describeContext() }
        });
        const { text: replyText, buttons } = parseAgentResponse(response.reply || "");
        const next = appendMessage(working, tabId, "assistant", replyText || "(empty reply)", { buttons });
        commit(next, activeId);
        setTransientStatus(null);
      } catch (error) {
        const next = appendMessage(working, tabId, "assistant", `Sorry — ${error.message || "the support agent failed"}`, {
          error: true
        });
        commit(next, activeId);
        setTransientStatus({ message: `Error: ${error.message || "support agent failed"}`, tone: "warn" });
      } finally {
        setBusy(false);
      }
    },
    [activeTab, busy, tabs, activeId, appendMessage, commit, describeContext]
  );

  // Run the side-effecting actions attached to a reply button, logging each as
  // a tool message. Ported from runActions().
  const runActions = useCallback(
    async (startTabs, tabId, actions) => {
      let working = startTabs;
      for (const action of actions) {
        const result = await executeAgentAction(action);
        working = appendMessage(working, tabId, "tool", `${action.tool}: ${result.summary}`);
        commit(working, activeId);
      }
      return working;
    },
    [appendMessage, commit, activeId]
  );

  // Activate a reply action button: marks it used, then either runs its actions
  // or sends its message back as a follow-up prompt. Ported from
  // activateSupportButton().
  const activateSupportButton = useCallback(
    async (messageId, buttonIndex) => {
      if (!activeTab || busy) return;
      const tabId = activeTab.id;
      const message = activeTab.messages.find((entry) => entry.id === messageId);
      const button = message?.buttons?.[Number(buttonIndex)];
      if (!button || button.used) return;

      // Mark the button used (immutably) and persist.
      let working = tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          messages: tab.messages.map((m) =>
            m.id === messageId
              ? { ...m, buttons: m.buttons.map((b, i) => (i === Number(buttonIndex) ? { ...b, used: true } : b)) }
              : m
          )
        };
      });
      commit(working, activeId);

      const label = button.message || button.label || "Yes";
      const actions = Array.isArray(button.actions) ? button.actions : [];
      if (actions.length) {
        working = appendMessage(working, tabId, "user", label);
        commit(working, activeId);
        setBusy(true);
        setTransientStatus({ message: "Working…", tone: "info" });
        try {
          await runActions(working, tabId, actions);
          setTransientStatus(null);
        } catch (error) {
          const next = appendMessage(working, tabId, "assistant", `Sorry — ${error.message || "that action failed"}`, {
            error: true
          });
          commit(next, activeId);
          setTransientStatus({ message: `Error: ${error.message || "action failed"}`, tone: "warn" });
        } finally {
          setBusy(false);
        }
        return;
      }
      sendSupportMessage(label);
    },
    [activeTab, busy, tabs, activeId, appendMessage, commit, runActions, sendSupportMessage]
  );

  // ---- Input handlers ------------------------------------------------------

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      const input = inputRef.current;
      if (!input) return;
      const value = input.value;
      input.value = "";
      sendSupportMessage(value);
    },
    [sendSupportMessage]
  );

  const onInputKeyDown = useCallback(
    (event) => {
      // Enter sends, Shift+Enter inserts a newline — the common chat convention.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    []
  );

  // Persist the in-progress draft per tab so it survives a tab switch, re-open,
  // or full reload.
  const onInputChange = useCallback(
    (event) => {
      const value = event.target.value;
      const next = tabs.map((tab) => (tab.id === activeId ? { ...tab, draft: value } : tab));
      commit(next, activeId);
    },
    [tabs, activeId, commit]
  );

  // Starter chips drop the prompt into the textarea (operator can edit first).
  const onStarter = useCallback((prompt) => {
    const input = inputRef.current;
    if (!input) return;
    input.value = prompt;
    input.focus();
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      /* ignore */
    }
  }, []);

  // Context-aware quick-reply chips. Hidden while offline or busy. Recomputed
  // from the live route on every navigation (no flicker — only the bar changes).
  const quickReplies = !configured || busy ? [] : supportQuickReplies(route);

  // ---- Render --------------------------------------------------------------

  return (
    <>
      <button
        id="support-chat-fab"
        type="button"
        className="support-chat-fab"
        aria-label="Open Runyard support chat"
        title="Runyard support agent (Ctrl+/)"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen((o) => !o)}
      >
        {sparkleIcon}
      </button>

      <aside
        id="support-chat"
        className={`support-chat${open ? "" : " hidden"}`}
        role="dialog"
        aria-label="Runyard user support agent"
        aria-modal="false"
      >
        <header className="support-chat-head">
          <div className="support-chat-tabs" role="tablist" aria-label="Chat sessions">
            {tabs.map((tab) => {
              const isActive = tab.id === activeId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`support-chat-tab${isActive ? " active" : ""}`}
                  title={tab.title}
                  onClick={() => setActiveSupportTab(tab.id)}
                >
                  <span className="support-chat-tab-label">{tab.title || "Chat"}</span>
                  <span
                    className="support-chat-tab-close"
                    role="button"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSupportTab(tab.id);
                    }}
                  >
                    ✕
                  </span>
                </button>
              );
            })}
          </div>
          <div className="support-chat-actions">
            <button
              type="button"
              className="support-chat-new"
              title="Start a new chat (resets context)"
              aria-label="New chat"
              onClick={addSupportTab}
            >
              ＋
            </button>
            <button
              type="button"
              className="support-chat-reset"
              title="Reset the current chat"
              aria-label="Reset chat"
              onClick={resetActiveSupportTab}
            >
              ↺
            </button>
            <details className="support-chat-overflow" ref={overflowRef} open={overflowOpen}>
              <summary
                className="support-chat-overflow-trigger"
                title="Chat options"
                aria-haspopup="menu"
                aria-label="Chat options"
                onClick={(e) => {
                  e.preventDefault();
                  setOverflowOpen((v) => !v);
                }}
              >
                ⋮
              </summary>
              <div className="support-chat-overflow-menu" role="menu">
                <button
                  type="button"
                  className="support-chat-clear-all"
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    clearAllSupportChats();
                  }}
                >
                  Clear conversation
                </button>
              </div>
            </details>
            <button
              type="button"
              className="support-chat-close"
              title="Hide chat"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="support-chat-status" role="status" aria-live="polite" hidden={!status.message} data-tone={status.message ? status.tone : undefined}>
          {status.message}
        </div>

        <ChatBody
          tab={activeTab}
          busy={busy}
          onStarter={onStarter}
          onActivate={activateSupportButton}
          bodyRef={bodyRef}
        />

        <div className="support-chat-quickreplies" role="group" aria-label="Suggested questions" hidden={!quickReplies.length}>
          {quickReplies.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="support-chat-quickreply"
              onClick={() => sendSupportMessage(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>

        <form className="support-chat-form" autoComplete="off" aria-describedby="support-chat-hint" onSubmit={onSubmit}>
          <textarea
            ref={inputRef}
            className="support-chat-input"
            rows="2"
            placeholder={'Ask the Runyard agent — e.g. "open the failed run"'}
            aria-label="Message"
            defaultValue={activeTab?.draft || ""}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
          />
          <button type="submit" className="primary support-chat-send" title="Send (Enter)">
            Send
          </button>
          <p className="support-chat-hint" id="support-chat-hint">
            Enter to send · Shift+Enter for newline
          </p>
        </form>
      </aside>
    </>
  );
}

export default SupportChat;
