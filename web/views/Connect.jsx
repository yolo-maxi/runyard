import { useState } from "react";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { copyText } from "../lib/clipboard.js";
import { Toolbar } from "../components/ui.jsx";

// A read-only input + Copy button — mirrors legacy `.copy-row` markup so
// styles.css applies unchanged. Copy always grabs the live value.
function CopyRow({ value, ariaLabel }) {
  return (
    <div className="copy-row">
      <input readOnly value={value} aria-label={ariaLabel} />
      <button className="button" type="button" onClick={() => copyText(value, "Copied")}>Copy</button>
    </div>
  );
}

// Masked secret with Show/Copy toggles. Mirrors legacy secretInput() +
// bindSecretToggles() (the `.secret-row`/`data-secret-*` markup and behaviour).
function SecretRow({ id, value, label = "Secret" }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="copy-row secret-row" data-secret-id={id}>
      <input
        id={id}
        readOnly
        type={revealed ? "text" : "password"}
        value={value}
        data-secret-value={value}
        aria-label={label}
      />
      <button type="button" className="button" data-secret-toggle={id} onClick={() => setRevealed((v) => !v)}>
        {revealed ? "Hide" : "Show"}
      </button>
      <button type="button" className="button" data-secret-copy={id} onClick={() => copyText(value, "Copied")}>Copy</button>
    </div>
  );
}

const INVITE_SCOPES = ["api", "mcp", "runner", "admin"];

// Connect an agent or teammate. Ported from legacy renderConnect(): setup cards
// (MCP / CLI / HTTP API / Runner pool), the install + multi-org guidance, and
// the invite-token generator (POST /api/tokens with selectable scopes).
export function Connect() {
  const origin = location.origin;
  const installCmd = `bash <(curl -fsSL ${origin}/install.sh)`;
  const mcpSnippet = `smithers-hub mcp install --all`;
  const cliSnippet = `smithers-hub login --url ${origin}\nsmithers-hub menu        # then: smithers-hub run hello`;
  const apiSnippet = `curl -H "authorization: Bearer $TOKEN" ${origin}/api/menu`;
  const runnerSnippet = `SMITHERS_HUB_URL=${origin} \\\nSMITHERS_HUB_TOKEN=shub_... \\\nSMITHERS_RUNNER_TAGS=linux,node,git,shell,web,smithers \\\nsmithers-hub-runner`;

  const [name, setName] = useState("teammate");
  const [scopes, setScopes] = useState(() => new Set(["api", "mcp"]));
  const [issued, setIssued] = useState(null); // { token } once minted

  function toggleScope(scope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function onSubmit(event) {
    event.preventDefault();
    const selected = INVITE_SCOPES.filter((s) => scopes.has(s));
    if (!selected.length) {
      toast("Pick at least one scope", "error");
      return;
    }
    try {
      const data = await api("/api/tokens", {
        method: "POST",
        body: { name: name || "teammate", scopes: selected }
      });
      setIssued({ token: data.token.token });
      toast("Token generated", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return (
    <>
      <Toolbar title="Connect an Agent or Teammate" shareHash={deepLinks.connect()} />
      <section className="panel">
        <h2>Connect agents</h2>
        <p className="muted">Now that your first capability has run, wire any of these channels. Bin names match the current build — copy and paste verbatim.</p>
        <div className="setup-grid">
          <article className="setup-step">
            <h3>MCP</h3>
            <p className="muted">Auto-configure every detected AI client (Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code).</p>
            <CopyRow value={mcpSnippet} ariaLabel="MCP install command" />
          </article>
          <article className="setup-step">
            <h3>CLI</h3>
            <p className="muted">Authenticate, then show the next-action menu and run <code>hello</code>.</p>
            <pre className="json">{cliSnippet}</pre>
          </article>
          <article className="setup-step">
            <h3>HTTP API</h3>
            <p className="muted">Bearer-token API; mirrors every CLI/MCP action. Discovery at <code>/llms.txt</code> + <code>/openapi.json</code>.</p>
            <CopyRow value={apiSnippet} ariaLabel="HTTP API example" />
          </article>
          <article className="setup-step">
            <h3>Runner pool</h3>
            <p className="muted">Bring more capacity online — one runner process per host.</p>
            <pre className="json">{runnerSnippet}</pre>
          </article>
        </div>
      </section>
      <section className="split">
        <div className="panel">
          <h2>1 · Install the client</h2>
          <p className="muted">One command — installs the <code>smithers-hub</code> CLI + MCP server and asks you to paste a token. Requires Node.js 18+.</p>
          <CopyRow value={installCmd} ariaLabel="Install command" />
          <h3>2 · Connect every AI agent</h3>
          <p className="muted">Auto-detects and configures the AI clients on your machine — no JSON editing:</p>
          <CopyRow value="smithers-hub mcp install --all" ariaLabel="MCP install all command" />
          <p className="muted">Supports Claude Code/Desktop, Codex, Cursor, Windsurf, Gemini, VS Code. Target one with <code>--client &lt;name&gt;</code>.</p>
          <h3>Multiple orgs?</h3>
          <p className="muted">Each org is its own hub. On the same machine: <code>smithers-hub login --remote &lt;org&gt;</code> (against that org's URL), then <code>smithers-hub mcp install --all --remote &lt;org&gt;</code> — its tools install alongside, namespaced <code>smithers-hub-&lt;org&gt;</code>.</p>
        </div>
        <div className="panel">
          <h2>Onboard a teammate</h2>
          <p className="muted">Generate a token to hand them. They run the install command above and paste this when asked — no secret baked into any command.</p>
          <form id="invite-form" className="form-grid" onSubmit={onSubmit}>
            <label>Scopes
              <div className="toolbar-actions">
                {INVITE_SCOPES.map((s) => (
                  <label className="muted" key={s}>
                    <input type="checkbox" className="invite-scope" value={s} checked={scopes.has(s)} onChange={() => toggleScope(s)} /> {s}
                  </label>
                ))}
              </div>
            </label>
            <label>Label<input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button className="primary" type="submit">Generate token</button>
          </form>
          <div id="invite-out">
            {issued ? (
              <>
                <h3>Send these to your teammate</h3>
                <p className="muted">Token (shown once) — they paste it when the installer asks. Hidden by default to keep it out of screenshots:</p>
                <SecretRow id="invite-token" value={issued.token} label="Teammate token" />
                <p className="muted">Install command:</p>
                <CopyRow value={installCmd} ariaLabel="Install command" />
                <p className="muted">Then they run <code>smithers-hub mcp install --all</code>. Revoke anytime under Tokens.</p>
              </>
            ) : null}
          </div>
          <h3>Shareable deep links</h3>
          <p className="muted">Every page, run, workflow, and artifact has a stable URL. Click any 🔗 in the console to copy one — paste into chat or docs.</p>
        </div>
      </section>
    </>
  );
}
