// Scope selection for minting access tokens: one row of preset buttons
// (Everything is the default; Read-only is one click) above collapsible
// scope groups that spell out what each scope grants. Metadata comes from
// GET /api/tokens/scopes so the UI can never drift from the server's
// vocabulary; the fallbacks below only cover the moments before that
// query resolves. Pure props + callbacks so tests can render it
// server-side with a stub payload.

export const EVERYTHING_SCOPES = ["api", "mcp", "approvals"];

// Presentation-only grouping of the scope vocabulary. Unknown server scopes
// land in "Other" so a new backend scope is never invisible in the UI.
const SCOPE_GROUPS = [
  { id: "operate", title: "Operate", blurb: "Run workflows, manage drafts, decide approvals" },
  { id: "inspect", title: "Inspect", blurb: "Read-only visibility, no changes" },
  { id: "machines", title: "Machines", blurb: "The runner protocol, for runner processes" },
  { id: "administration", title: "Administration", blurb: "Tokens, secrets, audit, updates — full control" }
];
const GROUP_OF = { api: "operate", mcp: "operate", approvals: "operate", read: "inspect", runner: "machines", admin: "administration" };

export function equalScopeSets(a, b) {
  const left = [...a];
  const right = new Set(b);
  return left.length === right.size && left.every((scope) => right.has(scope));
}

// The preset a selection corresponds to, if any (drives button highlighting
// and the readable label next to existing tokens).
export function presetForScopes(scopes, meta) {
  return (meta?.presets || []).find((preset) => equalScopeSets(preset.scopes, scopes)) || null;
}

function groupedScopes(meta) {
  const entries = meta?.scopes || [];
  const groups = SCOPE_GROUPS.map((group) => ({
    ...group,
    scopes: entries.filter((entry) => GROUP_OF[entry.scope] === group.id)
  })).filter((group) => group.scopes.length);
  const other = entries.filter((entry) => !GROUP_OF[entry.scope]);
  if (other.length) groups.push({ id: "other", title: "Other", blurb: "", scopes: other });
  return groups;
}

export function ScopePicker({ selected, onChange, meta }) {
  const presets = meta?.presets || [];
  const active = presetForScopes(selected, meta);
  const groups = groupedScopes(meta);

  function toggle(scope) {
    const next = new Set(selected);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    onChange(next);
  }

  return (
    <div className="scope-picker">
      {presets.length ? (
        <div className="toolbar-actions scope-presets">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={`button${active?.id === preset.id ? " primary" : ""}`}
              title={preset.summary}
              onClick={() => onChange(new Set(preset.scopes))}
            >
              {preset.title}
            </button>
          ))}
        </div>
      ) : null}
      <p className="muted scope-preset-summary">
        {active ? active.summary : "Custom selection — expand a group to review what each scope grants."}
      </p>
      {groups.map((group) => {
        const picked = group.scopes.filter((entry) => selected.has(entry.scope));
        return (
          <details className="scope-group" key={group.id}>
            <summary>
              {group.title}
              <span className="muted"> · {picked.length}/{group.scopes.length} selected{group.blurb ? ` — ${group.blurb}` : ""}</span>
            </summary>
            {group.scopes.map((entry) => (
              <label className="scope-option" key={entry.scope}>
                <input
                  type="checkbox"
                  className="token-scope"
                  value={entry.scope}
                  checked={selected.has(entry.scope)}
                  onChange={() => toggle(entry.scope)}
                />{" "}
                <strong>{entry.title}</strong> <code>{entry.scope}</code>
                <span className="muted scope-option-summary"> — {entry.summary}</span>
              </label>
            ))}
          </details>
        );
      })}
    </div>
  );
}
