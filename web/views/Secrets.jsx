import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { runnersCollection } from "../lib/collections.js";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { relativeTime } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { copyText } from "../lib/clipboard.js";
import { Toolbar } from "../components/ui.jsx";
import { useMe, meIsAdmin } from "../lib/me.js";

// Secrets view (admin). Ported from renderSecrets() + pollReauthRun(). Combines
// runner CLI auth-health cards (with per-runner/provider re-auth flow) and the
// encrypted reusable-secrets CRUD table + write-only form.

const REAUTH_DEADLINE_MS = 5.5 * 60_000;

function claudeTokenSecretName(runnerId) {
  return `RUNYARD_CLAUDE_OAUTH_TOKEN_${String(runnerId || "RUNNER").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`.slice(0, 128);
}

// Mirror legacy status() pill: <span class="status online|offline|..."> .
function StatusPill({ value }) {
  return <span className={`status ${value}`}>{value}</span>;
}

// One provider's auth-health pill. Ported from authHealthPill().
function AuthHealthPill({ provider, info }) {
  if (!info) {
    return (
      <span className="status offline" title="No report yet">
        {provider}: unknown
      </span>
    );
  }
  const expired = info.ok === false;
  // ok-but-not-fresh = the short access token lapsed but a refresh token keeps
  // the login alive (the CLI refreshes on next run). Show "valid" — not red —
  // and explain instead of dangling a stale "expires …" beside it.
  const refreshing = !expired && info.fresh === false && info.refreshable;
  const tone = expired ? "failed" : "succeeded";
  const label = expired ? "expired" : refreshing ? "valid · auto-refreshes" : "valid";
  const expiry = refreshing
    ? ""
    : info.expiresAt
    ? ` · expires ${relativeTime(info.expiresAt)}`
    : "";
  const acct = info.accountId ? ` · ${info.accountId}` : "";
  const title = [info.error || "", info.note || "", info.expiresAt || ""].filter(Boolean).join(" · ");
  return (
    <span className={`status ${tone}`} title={title}>
      {provider}: {label}
      {expiry}
      {acct}
    </span>
  );
}

// Drives a single reauth-cli run: POST to start, then poll GET /api/runs/:id
// every 2s (capped ~5.5min) for a `reauth.verification` event carrying the
// device-auth URL + code. Ported from bindReauthButtons() + pollReauthRun().
function ReauthControls({ runner }) {
  const queryClient = useQueryClient();
  // Active poll target: { provider, runId } | null. Plus a separate terminal
  // status render so the result sticks after polling stops.
  const [active, setActive] = useState(null);
  const [statusNode, setStatusNode] = useState(null);
  const [starting, setStarting] = useState(false);
  const [showClaudeConnect, setShowClaudeConnect] = useState(false);
  const [claudeToken, setClaudeToken] = useState("");
  const shownVerificationRef = useRef(false);
  const deadlineRef = useRef(0);

  const pollQ = useQuery({
    queryKey: ["reauth-run", active?.runId],
    queryFn: () => api(`/api/runs/${active.runId}`),
    enabled: Boolean(active?.runId),
    refetchInterval: 2000,
    retry: false,
    gcTime: 0
  });

  async function cleanupSecret(secretName) {
    if (!secretName) return;
    try {
      await api(`/api/secrets/${encodeURIComponent(secretName)}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    } catch {
      /* best effort: encrypted at rest, never exposed via API */
    }
  }

  async function startCodex() {
    const statusEl = (
      <p className="muted">Starting Codex device-code re-auth…</p>
    );
    setStatusNode(statusEl);
    setStarting(true);
    shownVerificationRef.current = false;
    deadlineRef.current = Date.now() + REAUTH_DEADLINE_MS;
    try {
      const res = await api("/api/capabilities/reauth-cli/run", {
        method: "POST",
        body: { input: { provider: "codex", runnerTag: "reauth" }, runnerId: runner.id }
      });
      setActive({ provider: "codex", runId: res.run.id });
    } catch (error) {
      setStatusNode(
        <p className="status failed">{error.message || "Re-auth failed to start"}</p>
      );
    } finally {
      setStarting(false);
    }
  }

  async function connectClaude(event) {
    event.preventDefault();
    const token = claudeToken.trim();
    if (!token) return toast("Paste the Claude OAuth token first", "error");
    const secretName = claudeTokenSecretName(runner.id);
    setStatusNode(<p className="muted">Sending Claude token to this runner…</p>);
    setStarting(true);
    shownVerificationRef.current = true;
    deadlineRef.current = Date.now() + REAUTH_DEADLINE_MS;
    try {
      await api(`/api/secrets/${encodeURIComponent(secretName)}`, {
        method: "PUT",
        body: {
          value: token,
          description: `One-time Claude OAuth token transfer for runner ${runner.id}`
        }
      });
      setClaudeToken("");
      const res = await api("/api/capabilities/reauth-cli/run", {
        method: "POST",
        body: {
          input: {
            provider: "claude",
            runnerTag: "reauth",
            oauthTokenSecretName: secretName,
            secretNames: [secretName]
          },
          runnerId: runner.id
        }
      });
      setActive({ provider: "claude", runId: res.run.id, secretName });
    } catch (error) {
      await cleanupSecret(secretName);
      setStatusNode(
        <p className="status failed">{error.message || "Claude token transfer failed"}</p>
      );
    } finally {
      setStarting(false);
    }
  }

  // React to each poll result the way pollReauthRun()'s loop body did.
  useEffect(() => {
    if (!active) return;
    const detail = pollQ.data;
    if (!detail && !pollQ.isError) return;

    if (Date.now() >= deadlineRef.current) {
      setStatusNode(
        <p className="status failed">{active.provider} re-auth timed out.</p>
      );
      cleanupSecret(active.secretName);
      setActive(null);
      return;
    }

    const run = detail?.run || detail || {};
    const events = detail?.events || [];

    if (!shownVerificationRef.current) {
      const ev = events.find((e) => e.type === "reauth.verification");
      const vinfo = ev?.data?.reauth;
      if (vinfo?.verificationUrl && vinfo?.userCode) {
        shownVerificationRef.current = true;
        const ttl = vinfo.expiresInSec
          ? ` (expires in ${Math.round(vinfo.expiresInSec / 60)}m)`
          : "";
        setStatusNode(
          <div className="panel">
            <p>
              Open{" "}
              <a href={vinfo.verificationUrl} target="_blank" rel="noopener">
                {vinfo.verificationUrl}
              </a>{" "}
              and enter code <code>{vinfo.userCode}</code>
              {ttl}.{" "}
              <button
                type="button"
                className="button"
                onClick={() => copyText(vinfo.userCode, "Code copied")}
              >
                Copy code
              </button>
            </p>
            <p className="muted">Waiting for authorization…</p>
          </div>
        );
      }
    }

    const status = run.status || "";
    if (status === "succeeded") {
      const reauth = run.output?.outputs?.reauth || {};
      setStatusNode(
        <p className="status succeeded">
          {active.provider === "claude" ? "Claude connected via OAuth token" : "codex re-authenticated"}
          {reauth.expiresAt ? ` · expires ${relativeTime(reauth.expiresAt)}` : ""}.
        </p>
      );
      cleanupSecret(active.secretName);
      toast(active.provider === "claude" ? "Claude connected" : `${active.provider} re-authenticated`, "ok");
      setActive(null);
      // Refresh runner auth-health after the runner reports back.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["runners"] });
      }, 1500);
      return;
    }
    if (status === "failed" || status === "cancelled") {
      setStatusNode(
        <p className="status failed">
          {active.provider} re-auth {status}: {run.error || ""}
        </p>
      );
      cleanupSecret(active.secretName);
      toast(`${active.provider} re-auth ${status}`, "error");
      setActive(null);
    }
  }, [active, pollQ.data, pollQ.isError, queryClient]);

  const busy = starting || Boolean(active);

  return (
    <>
      <div className="toolbar-actions">
        <button className="button" disabled={busy} onClick={startCodex}>
          Re-auth Codex
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => setShowClaudeConnect((open) => !open)}
          aria-expanded={showClaudeConnect ? "true" : "false"}
        >
          Connect Claude
        </button>
      </div>
      {showClaudeConnect ? (
        <form className="panel claude-token-connect" onSubmit={connectClaude}>
          <h4>Connect Claude with an OAuth token</h4>
          <p className="muted">
            On a machine where you can log into Claude normally, run{" "}
            <code>claude setup-token</code>. Paste the resulting{" "}
            <code>CLAUDE_CODE_OAUTH_TOKEN</code> here. RunYard sends it once to
            this runner, stores it on that runner, and never shows it again.
          </p>
          <label>
            Claude OAuth token{" "}
            <input
              type="password"
              value={claudeToken}
              autoComplete="off"
              placeholder="paste CLAUDE_CODE_OAUTH_TOKEN"
              onChange={(event) => setClaudeToken(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="toolbar-actions">
            <button
              type="button"
              className="button"
              onClick={() => copyText("claude setup-token", "Command copied")}
            >
              Copy command
            </button>
            <button type="submit" className="primary" disabled={busy || !claudeToken.trim()}>
              Save to this runner
            </button>
          </div>
        </form>
      ) : null}
      {statusNode ? (
        <div className="reauth-status" id={`reauth-status-${runner.id}`}>
          {statusNode}
        </div>
      ) : (
        <div className="reauth-status" id={`reauth-status-${runner.id}`} hidden />
      )}
    </>
  );
}

// One runner's auth-health card. Ported from runnerAuthStrip().
function RunnerAuthCard({ runner }) {
  const auth = runner.authHealth || null;
  return (
    <div className="panel secret-runner-card">
      <div className="toolbar">
        <h3>
          {runner.name} <span className="muted">{runner.id}</span>
        </h3>
        <div className="toolbar-actions">
          <StatusPill value={runner.online ? "online" : "offline"} />
        </div>
      </div>
      <p>
        <AuthHealthPill provider="Codex" info={auth?.codex || null} />{" "}
        <AuthHealthPill provider="Claude" info={auth?.claude || null} />
        {auth?.checkedAt ? (
          <span className="muted"> · checked {relativeTime(auth.checkedAt)}</span>
        ) : null}
      </p>
      <ReauthControls runner={runner} />
    </div>
  );
}

// Auth-health cards: online by default, offline collapsed behind a toggle.
// Ported from authHealthBlock().
function AuthHealthBlock({ runners }) {
  const [showOffline, setShowOffline] = useState(false);
  if (!runners.length) {
    return (
      <div className="empty">
        <p>No runners connected.</p>
      </div>
    );
  }
  const online = runners.filter((r) => r.online);
  const offline = runners.filter((r) => !r.online);
  return (
    <>
      {online.length ? (
        online.map((r) => <RunnerAuthCard key={r.id} runner={r} />)
      ) : (
        <div className="empty">
          <p>No online runners.</p>
        </div>
      )}
      {offline.length ? (
        <div className="runners-offline">
          <button
            className="button"
            id="authhealth-offline-toggle"
            aria-expanded={showOffline ? "true" : "false"}
            onClick={() => setShowOffline((s) => !s)}
          >
            {showOffline ? `Hide ${offline.length} offline` : `Show ${offline.length} offline`}
          </button>
          <div
            id="authhealth-offline-list"
            className={showOffline ? "" : "hidden"}
          >
            {offline.map((r) => (
              <RunnerAuthCard key={r.id} runner={r} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// Secrets CRUD table + write-only form. Ported from the secrets portion of
// renderSecrets() + bindSecretForm().
function SecretsBlock() {
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["secrets"],
    queryFn: () => api("/api/secrets"),
    retry: false
  });

  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const valueRef = useRef(null);

  // Disabled / 503 case: the endpoint reports it can't run without the key.
  const disabled =
    error && (/disabled/i.test(error.message) || error.status === 503);

  function invalidate() {
    return queryClient.invalidateQueries({ queryKey: ["secrets"] });
  }

  async function onSubmit(event) {
    event.preventDefault();
    const k = key.trim();
    if (!k || !value) return toast("Name and value are required", "error");
    try {
      await api(`/api/secrets/${encodeURIComponent(k)}`, {
        method: "PUT",
        body: { value, description: description.trim() }
      });
      toast(`Secret ${k} saved`, "ok");
      setValue("");
      await invalidate();
    } catch (err) {
      toast(err.message || "Save failed", "error");
    }
  }

  async function onDelete(secretKey) {
    if (
      !confirm(
        `Delete secret ${secretKey}? Runs that rely on it will lose the value.`
      )
    )
      return;
    try {
      await api(`/api/secrets/${encodeURIComponent(secretKey)}`, {
        method: "DELETE"
      });
      toast("Secret deleted", "ok");
      await invalidate();
    } catch (err) {
      toast(err.message || "Delete failed", "error");
    }
  }

  function onEdit(secret) {
    setKey(secret.key);
    setDescription(secret.description || "");
    setValue("");
    if (valueRef.current) valueRef.current.focus();
    toast(`Editing ${secret.key} — enter a new value to overwrite`, "info");
  }

  let body;
  if (isLoading) {
    body = <p className="muted">Loading…</p>;
  } else if (disabled) {
    body = (
      <div className="empty">
        <p>Secrets store disabled.</p>
        <p className="muted">
          Set <code>SECRETS_ENC_KEY</code> (a 32-byte base64/hex key) on the Hub
          to enable encrypted secrets, then restart.
        </p>
      </div>
    );
  } else if (error) {
    body = <p className="muted">{error.message}</p>;
  } else {
    const rows = data?.secrets || [];
    body = rows.length ? (
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.key}>
              <td data-label="Name">
                <code>{s.key}</code>
              </td>
              <td data-label="Description">{s.description || ""}</td>
              <td data-label="Updated">
                <span className="muted" title={s.updatedAt || ""}>
                  {relativeTime(s.updatedAt) || "—"}
                </span>
              </td>
              <td data-label="Action">
                <button className="button" onClick={() => onEdit(s)}>
                  Edit value
                </button>{" "}
                <button className="danger" onClick={() => onDelete(s.key)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className="empty">
        <p>No secrets yet.</p>
        <p className="muted">
          Add one below. Values are encrypted at rest and never returned by the
          API.
        </p>
      </div>
    );
  }

  return (
    <>
      {body}
      {disabled ? null : (
        <form id="secret-form" className="form-grid" onSubmit={onSubmit}>
          <label>
            Name{" "}
            <input
              id="secret-key"
              placeholder="GITHUB_TOKEN"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label>
            Description{" "}
            <input
              id="secret-desc"
              placeholder="What this is for"
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Value{" "}
            <input
              id="secret-value"
              ref={valueRef}
              type="password"
              placeholder="write-only — never shown again"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <button className="primary" type="submit">
            Save secret
          </button>
        </form>
      )}
    </>
  );
}

export function Secrets({ embedded = false } = {}) {
  const { data: me } = useMe();
  const { data: runners = [] } = useLiveQuery((q) => runnersCollection);

  if (!meIsAdmin(me)) {
    return (
      <>
        {embedded ? null : <Toolbar title="Secrets" shareHash={deepLinks.secrets()} />}
        <section className="panel">
          <div className="empty">
            <p>Admin only.</p>
            <p className="muted">
              Sign in with an admin-scoped token to manage secrets and CLI
              re-auth.
            </p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {embedded ? null : <Toolbar title="Secrets" shareHash={deepLinks.secrets()} />}
      <section className="panel">
        <h2>Runner CLI auth health</h2>
        <p className="muted">
          Codex/Claude subscription logins live on each runner host and expire
          silently. Re-auth from here without SSH.
        </p>
        <AuthHealthBlock runners={runners} />
      </section>
      <section className="panel">
        <h2>Reusable secrets</h2>
        <p className="muted">
          Admin-managed, encrypted at rest, injected into runs as env only for
          the secret names a capability/run opts into. Values are write-only.
        </p>
        <SecretsBlock />
      </section>
    </>
  );
}
