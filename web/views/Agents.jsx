import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { capabilitiesCollection } from "../lib/collections.js";
import { api } from "../lib/api.js";
import { deepLinks, useNavigate } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { Toolbar, ShareButton } from "../components/ui.jsx";

// Agents / Skills / Knowledge — tabbed view ported from legacy renderAgents()
// + editItem() + AGENT_TABS. Three tabs, each backed by its own endpoint; each
// renders a grid of item cards with related-content pills and cheap "Used by"
// workflow backlinks, plus a JSON editor panel for create/edit.

// Ported 1:1 from legacy AGENT_TABS. `link` builds the deep link for an item.
const AGENT_TABS = [
  { key: "agents", label: "Agents", endpoint: "agents", blurb: "Personas that combine skills + knowledge to handle workflows.", link: (slug) => deepLinks.agent(slug) },
  { key: "skills", label: "Skills", endpoint: "skills", blurb: "Reusable capabilities your agents can call on.", link: (slug) => deepLinks.skill(slug) },
  { key: "knowledge", label: "Knowledge", endpoint: "knowledge", blurb: "Documents and references agents draw from.", link: (slug) => deepLinks.knowledgeItem(slug) }
];

// The list endpoints all key their array under "knowledge"/"skills"/"agents".
const listKey = (endpoint) => (endpoint === "knowledge" ? "knowledge" : endpoint);

// Renders a `.pills` list, mirroring legacy pills(). Items may be strings or
// {label, href} objects; `link` builds an href from a string item.
function Pills({ items, kind = "pill", link = null }) {
  if (!items || !items.length) return null;
  return (
    <ul className="pills" role="list">
      {items.map((item, i) => {
        const label = typeof item === "string" ? item : item.label || item.slug || item.name;
        const href = typeof item === "object" && item.href ? item.href : link ? link(item) : "";
        return (
          <li className={kind} key={i}>
            {href ? <a href={href}>{label}</a> : label}
          </li>
        );
      })}
    </ul>
  );
}

// Single agent/skill/knowledge card. Mirrors legacy renderAgentCard() markup.
function AgentCard({ meta, item, capabilities, onEdit }) {
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
  const link = meta.link(item.slug);
  return (
    <article className="item agent-card" id={`${meta.key}-${item.slug}`}>
      <h3>
        <a href={link}>{name}</a> <ShareButton hash={link} label={`Copy share link to ${name}`} />
      </h3>
      <p className="muted agent-desc">{desc}</p>
      {item.url ? (
        <p className="muted">
          <a href={item.url} target="_blank" rel="noopener">{item.url}</a>
        </p>
      ) : null}
      {skillSlugs.length ? (
        <div className="pill-row">
          <span className="pill-label">Skills</span>
          <Pills items={skillSlugs} link={(s) => deepLinks.skill(s)} />
        </div>
      ) : null}
      {tools.length ? (
        <div className="pill-row">
          <span className="pill-label">Tools</span>
          <Pills items={tools} kind="pill tag" />
        </div>
      ) : null}
      {tags.length ? (
        <div className="pill-row">
          <span className="pill-label">Tags</span>
          <Pills items={tags} kind="pill tag" />
        </div>
      ) : null}
      {related.length ? (
        <div className="pill-row">
          <span className="pill-label">Used by</span>
          <Pills items={related.map((c) => ({ label: c.name, href: deepLinks.workflow(c.slug) }))} />
        </div>
      ) : null}
      <div className="toolbar-actions">
        <a className="button" href={link}>Open</a>
        <button onClick={() => onEdit(item.slug)}>Edit</button>
      </div>
    </article>
  );
}

// JSON editor panel — mirrors legacy editItem(). Renders a textarea seeded with
// the item JSON; on save POST (new) or PATCH (existing) then invalidate + toast.
function Editor({ meta, slug, item, onSaved }) {
  const editorRef = useRef(null);
  const [json, setJson] = useState(() => JSON.stringify(item, null, 2));

  // Reset the textarea when the target item changes (tab/slug switch).
  useEffect(() => {
    setJson(JSON.stringify(item, null, 2));
  }, [item]);

  // Scroll into view when opened, matching legacy scrollIntoView().
  useEffect(() => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const itemHash = `#agents/${meta.key}/${encodeURIComponent(slug || item.slug || "")}`;

  async function onSubmit(event) {
    event.preventDefault();
    let payload;
    try {
      payload = JSON.parse(json);
    } catch {
      toast("JSON is invalid", "error");
      return;
    }
    try {
      await api(slug ? `/api/${meta.endpoint}/${slug}` : `/api/${meta.endpoint}`, {
        method: slug ? "PATCH" : "POST",
        body: payload
      });
      toast("Saved", "ok");
      onSaved();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return (
    <section id="editor" className="panel" ref={editorRef}>
      <h2>
        {slug ? "Edit" : "New"} {slug ? <ShareButton hash={itemHash} label="Copy share link to this item" /> : null}
      </h2>
      <form id="item-form" className="form-grid" onSubmit={onSubmit}>
        <label>
          JSON
          <textarea id="item-json" value={json} onChange={(e) => setJson(e.target.value)} />
        </label>
        <button className="primary" type="submit">Save</button>
      </form>
    </section>
  );
}

export function Agents({ tab = "agents", slug }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const meta = AGENT_TABS.find((t) => t.key === tab) || AGENT_TABS[0];

  const listQuery = useQuery({
    queryKey: ["agents-view", meta.endpoint],
    queryFn: () => api(`/api/${meta.endpoint}`)
  });
  const items = listQuery.data?.[listKey(meta.endpoint)] || [];

  // Live capabilities for the "Used by" backlinks (knowledge has none).
  const { data: capabilities = [] } = useLiveQuery((q) => capabilitiesCollection);
  const caps = meta.key === "knowledge" ? [] : capabilities;

  const singular = meta.label.replace(/s$/, "");
  const newLabel = singular === "Knowledge" ? "entry" : singular;
  const sectionHash = `#agents/${meta.key}`;

  // Editor opens for a real slug (deep link / Edit) or for "" (New). null = closed.
  // We treat an empty string slug as "new"; undefined means no editor.
  const editing = slug !== undefined;
  const editTarget = editing
    ? slug
      ? items.find((entry) => entry.slug === slug)
      : { slug: "", name: "", title: "", description: "", body: "", instructions: "" }
    : null;

  const openEditor = (s) => navigate(`#agents/${meta.key}/${encodeURIComponent(s || "")}`);
  const closeEditor = () => navigate(sectionHash);
  const afterSave = () => {
    queryClient.invalidateQueries({ queryKey: ["agents-view", meta.endpoint] });
    closeEditor();
  };

  return (
    <>
      <Toolbar title="Agents" shareHash={sectionHash}>
        <button id="new-item" onClick={() => openEditor("")}>New {newLabel}</button>
      </Toolbar>
      <nav className="tabs">
        {AGENT_TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`tab ${t.key === meta.key ? "active" : ""}`}
            data-tab={t.key}
            onClick={() => navigate(deepLinks[t.key]())}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <p className="muted agents-blurb">{meta.blurb}</p>
      {listQuery.isLoading ? (
        <p className="muted">Loading…</p>
      ) : items.length ? (
        <div className="grid">
          {items.map((item) => (
            <AgentCard key={item.slug} meta={meta} item={item} capabilities={caps} onEdit={openEditor} />
          ))}
        </div>
      ) : (
        <div className="empty"><p>No {meta.label.toLowerCase()} yet.</p></div>
      )}
      {editing && editTarget ? (
        <Editor
          key={`${meta.key}-${slug}`}
          meta={meta}
          slug={slug}
          item={editTarget}
          onSaved={afterSave}
        />
      ) : null}
    </>
  );
}
