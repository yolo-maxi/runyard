import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { deepLinks, navigate } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { refreshCollection } from "../lib/collections.js";

// Default shape for a brand-new workflow.
function blankCap() {
  return {
    name: "", slug: "", description: "", category: "General", keywords: [],
    inputSchema: {}, outputSchema: {}, requiredRunnerTags: [], requiredSkills: [],
    requiredAgents: [], approvalPolicy: {}, workflow: { type: "builtin", name: "" }, enabled: true
  };
}

// Inline editor modal for creating (POST /api/workflows) or updating
// (PATCH /api/workflows/:slug) a workflow.
// `slug` empty ⇒ "New Workflow". On save, returns to the workflow detail when
// editing from a detail page, else back to the list. `onClose` lets the host
// dismiss the editor; `onSaved` lets it react locally.
export function WorkflowEditor({ slug = "", onClose, onSaved }) {
  const isEdit = Boolean(slug);
  const [cap, setCap] = useState(() => (isEdit ? null : blankCap()));
  const [loadError, setLoadError] = useState("");
  const editorRef = useRef(null);

  // Field state — initialized once the workflow loads.
  const [form, setForm] = useState({
    name: "", slug: "", description: "", category: "General", keywords: "",
    tags: "", enabled: true, approval: false, approvalReason: "", advancedJson: "{}"
  });

  useEffect(() => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  useEffect(() => {
    let alive = true;
    if (!isEdit) {
      const c = blankCap();
      seedForm(c);
      return undefined;
    }
    api(`/api/workflows/${slug}`)
      .then((data) => {
        if (!alive) return;
        const c = data.workflow;
        setCap(c);
        seedForm(c);
      })
      .catch((error) => { if (alive) setLoadError(error.message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function seedForm(c) {
    setForm({
      name: c.name || "",
      slug: c.slug || "",
      description: c.description || "",
      category: c.category || "General",
      keywords: (c.keywords || []).join(", "),
      tags: (c.requiredRunnerTags || []).join(", "),
      enabled: c.enabled !== false,
      approval: Boolean(c.approvalPolicy?.required),
      approvalReason: c.approvalPolicy?.reason || "",
      advancedJson: JSON.stringify({
        inputSchema: c.inputSchema || {},
        outputSchema: c.outputSchema || {},
        workflow: c.workflow || {},
        requiredSkills: c.requiredSkills || [],
        requiredAgents: c.requiredAgents || []
      }, null, 2)
    });
  }

  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }));

  const onSubmit = async (event) => {
    event.preventDefault();
    let advanced = {};
    try {
      advanced = JSON.parse(form.advancedJson || "{}");
    } catch {
      toast("Advanced JSON is invalid", "error");
      return;
    }
    const name = form.name.trim();
    if (!name) { toast("Name is required", "error"); return; }
    const base = cap || blankCap();
    const payload = {
      ...base,
      ...advanced,
      name,
      slug: slug || form.slug.trim() || undefined,
      description: form.description,
      category: form.category.trim() || "General",
      keywords: form.keywords.split(",").map((k) => k.trim()).filter(Boolean),
      requiredRunnerTags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      enabled: form.enabled,
      approvalPolicy: form.approval ? { required: true, reason: form.approvalReason.trim() } : { required: false }
    };
    try {
      const saved = slug
        ? await api(`/api/workflows/${slug}`, { method: "PATCH", body: payload })
        : await api("/api/workflows", { method: "POST", body: payload });
      toast("Workflow saved", "ok");
      await refreshCollection("workflows");
      if (typeof onSaved === "function") onSaved(saved);
      const targetSlug = saved?.workflow?.slug || slug;
      // Editing from a detail page returns there with the editor closed; a new
      // workflow created from the list lands on the list.
      const { segments } = deepLinks.parse();
      const onDetail = segments[0] === "workflows" && segments[1];
      if (onDetail && targetSlug) {
        navigate(deepLinks.workflow(targetSlug));
      } else if (targetSlug) {
        navigate(deepLinks.workflow(targetSlug));
      } else {
        navigate(deepLinks.workflows());
      }
      if (typeof onClose === "function") onClose();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  if (loadError) {
    return (
      <section id="editor" className="panel" ref={editorRef}>
        <p className="muted">{loadError}</p>
      </section>
    );
  }
  if (isEdit && !cap) {
    return (
      <section id="editor" className="panel" ref={editorRef}>
        <p className="muted">Loading workflow…</p>
      </section>
    );
  }

  return (
    <section id="editor" className="panel" ref={editorRef}>
      <h2>{slug ? "Edit" : "New"} Workflow</h2>
      <p className="muted">Workflows are stored as versioned bundles in the Hub database. Saving publishes a new version through the API — the same path agents use over MCP.</p>
      <form id="cap-form" className="form-grid" onSubmit={onSubmit}>
        <label>Name <span className="req">*</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required />
        </label>
        <label>Slug{slug ? "" : <span className="field-hint"> Leave blank to derive from the name.</span>}
          <input value={form.slug} onChange={(e) => set("slug", e.target.value)} disabled={Boolean(slug)} />
        </label>
        <label>Description
          <textarea value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label>Category
          <input value={form.category} onChange={(e) => set("category", e.target.value)} />
        </label>
        <label>Keywords
          <input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} />
          <span className="field-hint">Comma-separated.</span>
        </label>
        <label>Required runner tags
          <input value={form.tags} onChange={(e) => set("tags", e.target.value)} />
          <span className="field-hint">Comma-separated. Only runners with all these tags can execute it.</span>
        </label>
        <label className="inline">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled
        </label>
        <label className="inline">
          <input type="checkbox" checked={form.approval} onChange={(e) => set("approval", e.target.checked)} /> Require approval before running
        </label>
        <label>Approval reason
          <input value={form.approvalReason} onChange={(e) => set("approvalReason", e.target.value)} />
        </label>
        <details className="advanced">
          <summary>Advanced: input/output schema &amp; workflow (JSON)</summary>
          <label><textarea value={form.advancedJson} onChange={(e) => set("advancedJson", e.target.value)} /></label>
        </details>
        <button className="primary" type="submit">Save Workflow</button>
      </form>
    </section>
  );
}
