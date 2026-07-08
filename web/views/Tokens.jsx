import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";
import { toast } from "../lib/toast.js";
import { Toolbar, StatusBadge } from "../components/ui.jsx";
import { EVERYTHING_SCOPES, ScopePicker, presetForScopes } from "../components/ScopePicker.jsx";

// Reveal/copy a secret shown only once (e.g. a freshly minted token). Mirrors
// legacy secretInput() + bindSecretToggles() markup/classes/behaviour.
function SecretInput({ id, value, label = "Secret" }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="copy-row secret-row" data-secret-id={id}>
      <input
        id={id}
        readOnly
        type={shown ? "text" : "password"}
        value={value}
        aria-label={label}
      />
      <button type="button" className="button" onClick={() => setShown((s) => !s)}>
        {shown ? "Hide" : "Show"}
      </button>
      <button type="button" className="button" onClick={() => copyText(value, "Copied")}>
        Copy
      </button>
    </div>
  );
}

// Readable scope display for the token list: the preset name when the scopes
// match one (e.g. "Read-only"), always followed by the raw scope codes.
export function TokenScopes({ scopes = [], meta }) {
  const preset = presetForScopes(scopes, meta);
  return (
    <>
      {preset ? <>{preset.title}<br /></> : null}
      <span className="muted">{scopes.join(", ")}</span>
    </>
  );
}

// Existing tokens table. Ported from legacy tokenTable().
function TokenTable({ tokens, meta, onRevoke }) {
  if (!tokens.length) return <p className="muted">No tokens.</p>;
  return (
    <table className="table">
      <thead>
        <tr><th>Name</th><th>Scopes</th><th>State</th><th></th></tr>
      </thead>
      <tbody>
        {tokens.map((token) => (
          <tr key={token.id}>
            <td data-label="Name">
              {token.name}<br /><span className="muted">{token.id}</span>
            </td>
            <td data-label="Scopes"><TokenScopes scopes={token.scopes || []} meta={meta} /></td>
            <td data-label="State">
              <StatusBadge value={token.active ? "online" : "offline"} />
              {token.expiresAt ? (
                <><br /><span className="muted">expires {token.expiresAt}</span></>
              ) : null}
            </td>
            <td data-label="Action">
              {token.active ? (
                <button className="danger" onClick={() => onRevoke(token.id)}>Revoke</button>
              ) : (
                <span className="muted">revoked</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Access tokens (admin). Ported from renderTokens().
export function Tokens({ embedded = false } = {}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["tokens"], queryFn: () => api("/api/tokens") });
  const { data: scopeMeta } = useQuery({ queryKey: ["token-scopes"], queryFn: () => api("/api/tokens/scopes") });

  const [name, setName] = useState("local agent");
  // Default to the Everything preset; Read-only is one preset click away.
  const [scopes, setScopes] = useState(() => new Set(EVERYTHING_SCOPES));
  const [expiry, setExpiry] = useState("0");
  const [created, setCreated] = useState(null);

  async function handleCreate(event) {
    event.preventDefault();
    const expiresInDays = Number(expiry || 0);
    const known = scopeMeta?.known || [...scopes];
    const selected = known.filter((scope) => scopes.has(scope));
    if (!selected.length) {
      toast("Pick at least one scope", "error");
      return;
    }
    try {
      const result = await api("/api/tokens", {
        method: "POST",
        body: { name, scopes: selected, expiresInDays },
      });
      setCreated(result.token.token);
      toast("Token created", "ok");
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    } catch (error) {
      toast(error.message || "Create failed", "error");
    }
  }

  async function handleRevoke(id) {
    if (!confirm("Revoke this token? It will stop working immediately.")) return;
    try {
      await api(`/api/tokens/${id}`, { method: "DELETE" });
      toast("Token revoked", "ok");
    } catch (error) {
      toast(error.message || "Revoke failed", "error");
    }
    queryClient.invalidateQueries({ queryKey: ["tokens"] });
  }

  const tokens = data?.tokens || [];

  return (
    <>
      {embedded ? null : <Toolbar title="Access Tokens" shareHash={deepLinks.tokens()} />}
      <section className="split split-even">
        <div className="panel">
          <h2>Create Token</h2>
          <form className="form-grid" onSubmit={handleCreate}>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Scopes
              {scopeMeta ? (
                <ScopePicker selected={scopes} onChange={setScopes} meta={scopeMeta} />
              ) : (
                <p className="muted">Loading scopes…</p>
              )}
            </label>
            <label>
              Expires in days (0 = never)
              <input type="number" min="0" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>
            <button className="primary" type="submit">Create Token</button>
          </form>
          <div id="created-token">
            {created ? (
              <>
                <h3>Token created</h3>
                <p className="muted">
                  This value is shown once. Copy it now — hidden by default to keep it out of screenshots.
                </p>
                <SecretInput id="token-value" value={created} label="New token" />
              </>
            ) : null}
          </div>
        </div>
        <div className="panel">
          <h2>Existing Tokens</h2>
          {isLoading ? <p className="muted">Loading…</p> : <TokenTable tokens={tokens} meta={scopeMeta} onRevoke={handleRevoke} />}
        </div>
      </section>
    </>
  );
}
