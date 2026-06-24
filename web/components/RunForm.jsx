import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { deepLinks, navigate } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { relativeTime } from "../lib/runHelpers.js";
import { refreshCollection } from "../lib/collections.js";
import { RERUN_DRAFT_KEY, clearRerunDraft } from "../lib/runActions.js";
import { ShareButton, JsonBlock } from "./ui.jsx";

// Keys that render as a searchable repo/project picker (datalist) rather than a
// free-text box — matches legacy REPO_SELECTOR_KEYS. `repoDir` stays a warned
// manual escape hatch.
const REPO_SELECTOR_KEYS = new Set(["repo", "project"]);
const REPODIR_WARNING =
  "Advanced manual override: must be an absolute path that is runner-local and inside the runner's allowlisted improve roots. Prefer a configured repo/project above; do not combine with repo/project.";

// Read a persisted edit-rerun draft for this slug. Stored under RERUN_DRAFT_KEY
// by the "Edit & re-run" flow as { previousRunId, capabilitySlug, input, at }.
function loadRerunDraft(slug) {
  try {
    const raw = sessionStorage.getItem(RERUN_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (draft?.capabilitySlug !== slug) return null;
    return draft;
  } catch {
    try { sessionStorage.removeItem(RERUN_DRAFT_KEY); } catch { /* ignore */ }
    return null;
  }
}

// Field type for a JSON-Schema property — drives parsing on collect.
function fieldType(prop = {}) {
  const type = prop.type || "string";
  if (Array.isArray(prop.enum)) return "string";
  if (type === "boolean") return "boolean";
  if (type === "number" || type === "integer") return "number";
  if (type === "object" || type === "array") return "json";
  return "string";
}

function emptyValueFor(prop) {
  return fieldType(prop) === "boolean" ? false : "";
}

// Cast a stored input value into the string/boolean the control expects.
function toControlValue(prop, value) {
  if (value == null) return emptyValueFor(prop);
  const ftype = fieldType(prop);
  if (ftype === "boolean") return Boolean(value);
  if (ftype === "json") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return String(value);
}

// One labeled control for a schema property. Repo/project keys get a datalist
// picker (data-repo-selector); repoDir gets a warned free-text box.
function SchemaField({ field, value, error, repoOptions, onChange }) {
  const { key, prop, required } = field;
  const hint = prop.description ? <span className="field-hint">{prop.description}</span> : null;
  const label = (
    <>{key}{required ? <span className="req"> *</span> : null}</>
  );

  if (REPO_SELECTOR_KEYS.has(key) && (prop.type || "string") === "string" && !Array.isArray(prop.enum)) {
    const listId = `repo-options-${key}`;
    const matches = repoOptions.filter((opt) => (opt.selector || "repo") === key);
    const def = matches.find((opt) => opt.default);
    const placeholder = def ? `Search ${key}s… (default: ${def.value})` : `Search configured ${key}s…`;
    return (
      <label>{label}{hint}
        <input
          type="text"
          data-repo-selector={key}
          list={listId}
          placeholder={placeholder}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(key, e.target.value)}
        />
        <datalist id={listId}>
          {matches.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {(opt.label || opt.value) + (opt.default ? " — default" : "")}
            </option>
          ))}
        </datalist>
        <span className="field-error">{error || ""}</span>
      </label>
    );
  }

  if (key === "repoDir" && (prop.type || "string") === "string") {
    return (
      <label>{label}
        <span className="field-hint warn">{prop.description ? `${prop.description} ` : ""}{REPODIR_WARNING}</span>
        <input
          type="text"
          placeholder="/abs/runner-local/path (advanced)"
          value={value}
          onChange={(e) => onChange(key, e.target.value)}
        />
        <span className="field-error">{error || ""}</span>
      </label>
    );
  }

  let control;
  if (Array.isArray(prop.enum)) {
    control = (
      <select value={value} onChange={(e) => onChange(key, e.target.value)}>
        <option value="">—</option>
        {prop.enum.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  } else if (fieldType(prop) === "boolean") {
    control = <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(key, e.target.checked)} />;
  } else if (fieldType(prop) === "number") {
    control = <input type="number" value={value} onChange={(e) => onChange(key, e.target.value)} />;
  } else if (fieldType(prop) === "json") {
    control = (
      <textarea
        placeholder={prop.type === "array" ? "[]" : "{}"}
        value={value}
        onChange={(e) => onChange(key, e.target.value)}
      />
    );
  } else {
    control = <input type="text" value={value} onChange={(e) => onChange(key, e.target.value)} />;
  }
  return <label>{label}{hint}{control}<span className="field-error">{error || ""}</span></label>;
}

// Collect structured fields back into an input object, validating required +
// JSON/number fields. Ported from collectSchemaInput().
function collectSchemaInput(fields, values) {
  const errors = {};
  const out = {};
  for (const { key, prop, required } of fields) {
    const ftype = fieldType(prop);
    if (ftype === "boolean") {
      out[key] = Boolean(values[key]);
      continue;
    }
    const raw = String(values[key] ?? "").trim();
    if (!raw) {
      if (required) errors[key] = "required";
      continue;
    }
    if (ftype === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) errors[key] = "must be a number";
      else out[key] = n;
    } else if (ftype === "json") {
      try { out[key] = JSON.parse(raw); } catch { errors[key] = "invalid JSON"; }
    } else {
      out[key] = raw;
    }
  }
  return { ok: Object.keys(errors).length === 0, values: out, errors };
}

// Run form for a workflow. Ported from legacy showRunForm(): schema-driven
// inputs, a repo/project datalist picker, a raw-JSON escape hatch
// ("Edit as raw JSON instead"), and edit-rerun draft restore from
// sessionStorage (submit keeps rerun lineage; the button reads
// "Re-run with edited input").
export function RunForm({ cap, slug }) {
  const schema = cap.inputSchema || {};
  const fields = useMemo(() => {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    return Object.keys(props).map((key) => ({ key, prop: props[key], required: required.has(key) }));
  }, [schema]);
  const hasFields = fields.length > 0;
  const approval = cap.approvalPolicy?.required;

  // sample = all-empty defaults; the discard action snaps back to these.
  const sample = useMemo(() => {
    const out = {};
    for (const { key, prop } of fields) out[key] = toControlValue(prop, undefined);
    return out;
  }, [fields]);

  const [draft, setDraft] = useState(() => loadRerunDraft(slug));
  const initialInput = draft?.input && typeof draft.input === "object" && !Array.isArray(draft.input)
    ? draft.input
    : null;

  const [values, setValues] = useState(() => {
    if (!initialInput) return { ...sample };
    const out = {};
    for (const { key, prop } of fields) out[key] = toControlValue(prop, initialInput[key]);
    return out;
  });
  const [errors, setErrors] = useState({});
  const [rawText, setRawText] = useState(() => JSON.stringify(initialInput || (hasFields ? {} : {}), null, 2));
  const [noSchemaRaw, setNoSchemaRaw] = useState("{}");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [repoOptions, setRepoOptions] = useState([]);
  const submitLabel = draft ? "Re-run with edited input" : (hasFields ? "Create Run" : "Create Run");

  const editorRef = useRef(null);
  useEffect(() => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Hydrate repo/project pickers from the catalog (/api/repo-options).
  useEffect(() => {
    let alive = true;
    if (!fields.some((f) => REPO_SELECTOR_KEYS.has(f.key))) return undefined;
    api("/api/repo-options")
      .then((catalog) => { if (alive) setRepoOptions(Array.isArray(catalog?.options) ? catalog.options : []); })
      .catch(() => { if (alive) setRepoOptions([]); });
    return () => { alive = false; };
  }, [fields]);

  const onField = (key, val) => setValues((prev) => ({ ...prev, [key]: val }));

  const discardDraft = () => {
    clearRerunDraft();
    setDraft(null);
    setValues({ ...sample });
    setRawText(JSON.stringify({}, null, 2));
    toast("Draft discarded", "ok");
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    let input;
    try {
      if (!hasFields) {
        input = JSON.parse(noSchemaRaw || "{}");
      } else if (advancedOpen) {
        input = JSON.parse(rawText || "{}");
      } else {
        const collected = collectSchemaInput(fields, values);
        setErrors(collected.errors);
        if (!collected.ok) { toast("Please fix the highlighted fields", "error"); return; }
        input = collected.values;
      }
    } catch {
      toast("Input is not valid JSON", "error");
      return;
    }
    try {
      const result = draft?.previousRunId
        ? await api(`/api/runs/${draft.previousRunId}/rerun`, { method: "POST", body: { input } })
        : await api(`/api/capabilities/${slug}/run`, { method: "POST", body: { input } });
      if (draft) clearRerunDraft();
      toast(draft ? "Edited re-run queued" : "Run created", "ok");
      await refreshCollection("runs");
      navigate(deepLinks.run(result.run.id));
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const draftStamped = draft?.at ? relativeTime(draft.at) : "";

  return (
    <section id="editor" className="panel" ref={editorRef}>
      <h2>Run {cap.name} <ShareButton hash={deepLinks.workflow(slug)} label={`Copy share link to ${cap.name}`} /></h2>
      <p className="muted">{cap.description || ""}</p>
      <p className="muted"><span className="kbd">{deepLinks.abs(deepLinks.workflow(slug))}</span></p>
      {draft ? (
        <div className="notice rerun-draft-banner" id="rerun-draft-banner" role="status">
          <div className="rerun-draft-banner-text">
            <strong>Draft restored{draftStamped ? ` from ${draftStamped}` : ""}</strong>
            <span className="muted">
              Editing input before re-running{" "}
              <a href={deepLinks.run(draft.previousRunId)}>{draft.previousRunId}</a>. Submit to keep rerun lineage, or discard to start clean.
            </span>
          </div>
          <button type="button" className="button rerun-draft-discard" onClick={discardDraft} aria-label="Discard restored rerun draft">Discard</button>
        </div>
      ) : null}
      {approval ? (
        <p className="notice">This workflow may ask for approval at checkpoints while it runs.{cap.approvalPolicy?.reason ? ` ${cap.approvalPolicy.reason}` : ""}</p>
      ) : null}
      {cap.supervision?.default ? (
        <p className="notice">This run is supervised by <strong>run-smithers</strong>: the Hub creates a supervising run that wraps it, records lineage, recovers interrupted attempts, and flags it for attention instead of reporting a silent success if it can't finish.</p>
      ) : null}
      <form id="run-form" className="form-grid" onSubmit={onSubmit}>
        {hasFields ? (
          fields.map((field) => (
            <SchemaField
              key={field.key}
              field={field}
              value={values[field.key]}
              error={errors[field.key]}
              repoOptions={repoOptions}
              onChange={onField}
            />
          ))
        ) : (
          <label>Input JSON
            <textarea placeholder="{}" value={noSchemaRaw} onChange={(e) => setNoSchemaRaw(e.target.value)} />
            <span className="field-hint">This workflow has no declared input schema. Provide raw JSON.</span>
            <span className="field-error" />
          </label>
        )}
        {hasFields ? (
          <details className="advanced" onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
            <summary>Edit as raw JSON instead</summary>
            <label><textarea placeholder="{}" value={rawText} onChange={(e) => setRawText(e.target.value)} /></label>
          </details>
        ) : null}
        <button className="primary" type="submit">{submitLabel}</button>
      </form>
      <details className="advanced"><summary>Workflow contract</summary><JsonBlock value={cap} /></details>
    </section>
  );
}
