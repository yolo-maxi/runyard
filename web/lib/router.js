import { useSyncExternalStore, useCallback } from "react";

// Hash-based router. The deep-link grammar is ported 1:1 from the legacy
// public/app.js `deepLinks` object so every existing shareable URL keeps
// working ("every URL in the Hub is shareable" is a documented feature).

// Matches legacy deepLinks.base() — absolute "/app" URL so share links are
// copy-pasteable regardless of the current path.
const base = () => (typeof location !== "undefined" ? `${location.origin}/app` : "");

export const deepLinks = {
  base,
  abs(hash) {
    if (!hash) return base();
    return `${base()}${hash.startsWith("#") ? hash : `#${hash}`}`;
  },
  parse(raw = (typeof location !== "undefined" ? location.hash : "") || "") {
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
  work: () => "#work",
  workItem: (id) => `#work/${encodeURIComponent(id)}`,
  workItemFlow: (id) => `#work/${encodeURIComponent(id)}/flow`,
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
  artifact: (artifact) =>
    artifact?.runId
      ? `#runs/${encodeURIComponent(artifact.runId)}/artifacts/${encodeURIComponent(artifact.id)}`
      : "#runs",
  tokens: () => "#tokens",
  runners: () => "#runners",
  schedules: () => "#schedules",
  schedule: (id) => `#schedules/${encodeURIComponent(id)}`,
  audit: () => "#audit",
  secrets: () => "#secrets",
  connect: () => "#connect",
  approvals: () => "#approvals",
  approval: (id) => `#approvals/${encodeURIComponent(id)}`,
  settings: () => "#settings",
  brand: () => "#brand"
};

// Expose for devtools/tests/the server-served-JS check, matching legacy app.js.
if (typeof window !== "undefined") {
  window.smithersDeepLinks = deepLinks;
}

function subscribe(callback) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getSnapshot() {
  return typeof location !== "undefined" ? location.hash : "";
}

// Reactive hash route. Re-renders subscribers whenever location.hash changes.
export function useHashRoute() {
  const hash = useSyncExternalStore(subscribe, getSnapshot, () => "");
  return deepLinks.parse(hash || "");
}

// Navigate by setting the hash (keeps history + share semantics). Accepts a
// hash string (with or without leading '#').
export function navigate(hash) {
  if (typeof location === "undefined") return;
  const next = hash?.startsWith("#") ? hash : `#${hash || ""}`;
  if (location.hash === next) {
    // Same hash: fire a manual hashchange so views can re-pull if needed.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = next;
  }
}

export function useNavigate() {
  return useCallback(navigate, []);
}
