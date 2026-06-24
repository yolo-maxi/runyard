import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks, navigate } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { relativeTime, isActiveRun } from "../lib/runHelpers.js";
import { refreshCollection } from "../lib/collections.js";
import { Toolbar, ShareButton } from "../components/ui.jsx";
import { Pills } from "../components/WorkflowParts.jsx";
import { WorkflowEditor } from "../components/WorkflowEditor.jsx";

// --- Sample workflow templates ----------------------------------------------
// Cheap starter capabilities seeded into the tenant when a user clicks
// "Use template" on the empty workflows page. POSTed through the existing
// /api/capabilities upsert path. Ported 1:1 from legacy WORKFLOW_TEMPLATES.
const WORKFLOW_TEMPLATES = [
  {
    slug: "hello-world",
    name: "Hello world",
    category: "starter",
    description: "Prints a greeting from a runner. Quickest way to confirm the pipe is wired end to end.",
    enabled: true,
    requiredRunnerTags: ["smithers"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } } },
    workflow: { type: "shell", entry: "echo \"hello, ${name:-world} — run ${SMITHERS_RUN_ID:-?} of hello-world completed successfully\"" }
  },
  {
    slug: "fetch-and-summarize",
    name: "Fetch & summarize URL",
    category: "starter",
    description: "Downloads a page and asks the default agent to summarize it. Tests outbound HTTP + agent loop.",
    enabled: true,
    requiredRunnerTags: ["smithers", "web"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string", description: "Page to summarize" } } },
    workflow: { type: "shell", entry: "echo summarize $url" }
  },
  {
    slug: "scheduled-check",
    name: "Scheduled health check",
    category: "starter",
    description: "Skeleton for a periodic check: hit an endpoint, alert on failure. Pair with /schedule when ready.",
    enabled: true,
    requiredRunnerTags: ["smithers"],
    requiredSkills: [],
    requiredAgents: [],
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    workflow: { type: "shell", entry: "curl -sf $url" }
  }
];

function TemplateCard({ template, onUse }) {
  const [busy, setBusy] = useState(false);
  return (
    <article className="template-card">
      <h3>{template.name}</h3>
      <p className="muted">{template.description}</p>
      <p className="template-meta muted">{template.category} · runs on <code>{(template.requiredRunnerTags || []).join(", ") || "any"}</code></p>
      <div className="toolbar-actions">
        <button className="primary" disabled={busy} onClick={async () => { setBusy(true); const ok = await onUse(template); if (!ok) setBusy(false); }}>
          Use template
        </button>
      </div>
    </article>
  );
}

// First-run empty-state onboarding card. Ported from legacy onboardingCard()
// + bindOnboardingCard(): browse templates, run a sample, open runs.
function OnboardingCard() {
  const sample = WORKFLOW_TEMPLATES[0];
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("Run sample");

  const runSample = async () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.slug === sample.slug) || WORKFLOW_TEMPLATES[0];
    if (!template) return;
    setBusy(true);
    setLabel("Starting…");
    try {
      try { await api("/api/capabilities", { method: "POST", body: template }); } catch { /* already exists */ }
      const result = await api(`/api/capabilities/${encodeURIComponent(template.slug)}/run`, { method: "POST", body: { input: {} } });
      const runId = result?.run?.id;
      toast("Sample run queued", "ok");
      await refreshCollection("runs");
      if (runId) navigate(deepLinks.run(runId));
      else navigate(deepLinks.home());
    } catch (error) {
      toast(error.message || "Could not start sample run", "error");
      setBusy(false);
      setLabel("Run sample");
    }
  };

  const steps = [
    {
      n: 1,
      title: "Browse workflow templates",
      body: "Start from a curated capability. Each one ships with a sample input and a runner profile.",
      cta: <a className="button" href="/workflow-templates/" target="_blank" rel="noopener">Browse templates ↗</a>
    },
    {
      n: 2,
      title: "Run a sample",
      body: `“${sample.name}” seeds in your tenant, queues a run, and opens its detail page automatically.`,
      cta: <button className="primary" disabled={busy} onClick={runSample}>{label}</button>
    },
    {
      n: 3,
      title: "Open the run detail",
      body: "Watch the live progress strip, browse artifacts, and re-run with one click from the deep-linkable URL.",
      cta: <a className="button" href="#runs">Open Runs</a>
    }
  ];

  return (
    <section className="onboarding-card" role="region" aria-label="Get started in 3 steps">
      <header className="onboarding-card-head">
        <h2>Welcome to Runyard</h2>
        <p className="muted">No workflows yet — follow these three steps to see one running end to end.</p>
      </header>
      <ol className="onboarding-card-steps">
        {steps.map((step) => (
          <li key={step.n} className="onboarding-card-step">
            <span className="onboarding-card-num" aria-hidden="true">{step.n}</span>
            <div className="onboarding-card-body">
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
              <div className="onboarding-card-cta">{step.cta}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WorkflowCard({ cap, stats }) {
  const skills = (cap.requiredSkills || []).slice(0, 4);
  const agents = (cap.requiredAgents || []).slice(0, 4);
  const tags = (cap.requiredRunnerTags || []).slice(0, 4);
  const lastChip = stats.last
    ? <span className="chip chip-last-run" title="Last run">⏱ {stats.last}</span>
    : <span className="chip chip-last-run muted" title="No runs yet">never run</span>;
  const rateChip = stats.success != null
    ? <span className={`chip chip-success ${stats.success >= 90 ? "ok" : stats.success >= 60 ? "warn" : "danger"}`} title={`Success rate over last ${stats.total} run${stats.total === 1 ? "" : "s"}`}>✓ {stats.success}%</span>
    : null;
  return (
    <article className="item workflow-card" id={`workflow-${cap.slug}`}>
      <h3>
        <a href={deepLinks.workflow(cap.slug)}>{cap.name}</a>{" "}
        <ShareButton hash={deepLinks.workflow(cap.slug)} label={`Copy share link to ${cap.name}`} />
      </h3>
      <p className="muted workflow-desc">{cap.description}</p>
      <p className="workflow-meta">{cap.category} · v{cap.version} · {cap.enabled ? "enabled" : "disabled"}{cap.approvalPolicy?.required ? " · needs approval" : ""}</p>
      <p className="workflow-run-chips">{lastChip}{rateChip}</p>
      {agents.length ? <div className="pill-row"><span className="pill-label">Agents</span><Pills items={agents} /></div> : null}
      {skills.length ? <div className="pill-row"><span className="pill-label">Skills</span><Pills items={skills} /></div> : null}
      {tags.length ? <div className="pill-row"><span className="pill-label">Runner tags</span><Pills items={tags} kind="pill tag" /></div> : null}
      <div className="toolbar-actions">
        <a className="button" href={deepLinks.workflow(cap.slug)}>Open</a>
        <button className="primary" title="Run this workflow now" onClick={() => navigate(deepLinks.workflowRun(cap.slug))}>▶ Run</button>
        <button onClick={() => navigate(deepLinks.workflowEdit(cap.slug))}>Edit</button>
      </div>
    </article>
  );
}

// Workflows / capabilities list. Ported from legacy renderCapabilities():
// cards with a last-run chip + success rate, onboarding + starter templates
// when empty, and the "New Workflow" editor.
export function Workflows() {
  const [editing, setEditing] = useState(null); // null | { slug } for the New-workflow editor

  const capsQuery = useQuery({
    queryKey: ["capabilities"],
    queryFn: async () => (await api("/api/capabilities")).capabilities ?? [],
    refetchInterval: 60_000
  });
  const runsQuery = useQuery({
    queryKey: ["runs", "for-workflows"],
    queryFn: async () => {
      try { return (await api("/api/runs?limit=200")).runs ?? []; } catch { return []; }
    },
    refetchInterval: 30_000
  });

  const capabilities = capsQuery.data ?? [];
  const runs = runsQuery.data ?? [];

  // Bucket the last 10 runs per workflow for the per-card last-run chip +
  // success rate (avoids an API call per card).
  const statsBySlug = useMemo(() => {
    const runsBySlug = new Map();
    for (const run of runs) {
      const slug = run.capabilitySlug;
      if (!slug) continue;
      if (!runsBySlug.has(slug)) runsBySlug.set(slug, []);
      const bucket = runsBySlug.get(slug);
      if (bucket.length < 10) bucket.push(run);
    }
    const out = new Map();
    for (const [slug, bucket] of runsBySlug.entries()) {
      if (!bucket.length) { out.set(slug, { last: "", success: null, total: 0 }); continue; }
      const finished = bucket.filter((r) => !isActiveRun(r));
      const ok = finished.filter((r) => r.status === "succeeded").length;
      const rate = finished.length ? Math.round((ok / finished.length) * 100) : null;
      out.set(slug, { last: relativeTime(bucket[0].createdAt), success: rate, total: bucket.length });
    }
    return out;
  }, [runs]);

  const useTemplate = async (template) => {
    try {
      await api("/api/capabilities", { method: "POST", body: template });
      toast(`Created ${template.name}`, "ok");
      await refreshCollection("capabilities");
      navigate(deepLinks.workflow(template.slug));
      return true;
    } catch (error) {
      toast(error.message || "Could not create template", "error");
      return false;
    }
  };

  const statsFor = (slug) => statsBySlug.get(slug) || { last: "", success: null, total: 0 };

  return (
    <>
      <Toolbar title="Workflows" shareHash={deepLinks.workflows()}>
        <button id="new-cap" onClick={() => setEditing({ slug: "" })}>New Workflow</button>
      </Toolbar>
      <p className="muted">A workflow is a capability your agents can invoke. They appear as MCP tools and as launchable buttons here. Each workflow has a shareable link — open 🔗 to copy.</p>
      {capabilities.length ? (
        <div className="grid">
          {capabilities.map((cap) => <WorkflowCard key={cap.slug} cap={cap} stats={statsFor(cap.slug)} />)}
        </div>
      ) : (
        <>
          <OnboardingCard />
          <h2 className="section-heading">Starter templates</h2>
          <div className="grid template-grid">
            {WORKFLOW_TEMPLATES.map((template) => (
              <TemplateCard key={template.slug} template={template} onUse={useTemplate} />
            ))}
          </div>
        </>
      )}
      {editing ? (
        <WorkflowEditor slug={editing.slug} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
      ) : (
        <section id="editor" className="panel hidden" />
      )}
    </>
  );
}
