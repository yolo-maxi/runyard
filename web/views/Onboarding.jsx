import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useNavigate } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";
import { toast } from "../lib/toast.js";
import { Toolbar } from "../components/ui.jsx";

// Starter workflows offered at the end of the wizard. Inlined from the legacy
// WORKFLOW_TEMPLATES list — "Use template" POSTs the full template to
// /api/capabilities, then routes to the new workflow.
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

function TemplateCard({ template }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function use() {
    setBusy(true);
    try {
      await api("/api/capabilities", { method: "POST", body: template });
      toast(`Created ${template.name}`, "ok");
      navigate(`#workflows/${template.slug}`);
    } catch (error) {
      toast(error.message || "Could not create template", "error");
      setBusy(false);
    }
  }
  return (
    <article className="template-card">
      <h3>{template.name}</h3>
      <p className="muted">{template.description}</p>
      <p className="template-meta muted">{template.category} · runs on <code>{(template.requiredRunnerTags || []).join(", ") || "any"}</code></p>
      <div className="toolbar-actions">
        <button className="primary" data-use-template={template.slug} disabled={busy} onClick={use}>Use template</button>
      </div>
    </article>
  );
}

// Three-step guided setup. Ported from legacy renderOnboarding():
//   1. Name the runner → mint a runner-scoped token (degrade gracefully if the
//      caller lacks admin scope) and build the install command.
//   2. Show the command + poll /api/runners until a runner heartbeats online.
//   3. Offer a starter workflow.
// The wizard step lives in React state (no DOM mutation), and the heartbeat
// poll is a useQuery with refetchInterval that runs only while on step 2.
export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1 | 2 | 3
  const [runnerName, setRunnerName] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [online, setOnline] = useState(null); // the runner once it connects

  // Poll for a runner coming online, but only while waiting on step 2.
  useQuery({
    queryKey: ["runners"],
    queryFn: async () => {
      const result = await api("/api/runners");
      const found = (result.runners || []).find((r) => r.online);
      if (found && !online) {
        setOnline(found);
        setStep(3);
        toast(`Runner ${found.name} connected`, "ok");
      }
      return result;
    },
    enabled: step === 2 && !online,
    refetchInterval: 2500
  });

  async function onNameSubmit(event) {
    event.preventDefault();
    const name = (runnerName || "").trim() || "runner";
    let token = "";
    try {
      const data = await api("/api/tokens", { method: "POST", body: { name: `onboarding:${name}`, scopes: ["runner"] } });
      token = data.token?.token || "";
    } catch (error) {
      // Token issuance requires admin scope — degrade gracefully so users
      // without that scope still see the install command, just without an
      // auto-injected token. They can paste their own.
      toast(error.message || "Could not auto-mint a runner token — paste your own when prompted", "info");
    }
    const cmd = token
      ? `SMITHERS_HUB_URL=${location.origin} SMITHERS_HUB_TOKEN=${token} SMITHERS_RUNNER_NAME=${name} bash <(curl -fsSL ${location.origin}/install.sh)`
      : `SMITHERS_HUB_URL=${location.origin} SMITHERS_RUNNER_NAME=${name} bash <(curl -fsSL ${location.origin}/install.sh)`;
    setInstallCmd(cmd);
    setStep(2);
  }

  return (
    <>
      <Toolbar title="Get started" shareHash="#onboarding" />
      <section className="panel onboarding">
        <ol className="onboarding-steps">
          <li className={`onboarding-step${step === 1 ? " active" : ""}`} id="ob-step-1">
            <h2><span className="onboarding-num">1</span> Name your runner</h2>
            <p className="muted">This is the label you'll see in the Runners table. Hostnames work well.</p>
            <form id="onboarding-name-form" className="form-grid" onSubmit={onNameSubmit}>
              <label>Runner name <input id="ob-runner-name" placeholder="e.g. fran-laptop" autoComplete="off" value={runnerName} onChange={(e) => setRunnerName(e.target.value)} /></label>
              <button className="primary" type="submit">Continue</button>
            </form>
          </li>
          <li className={`onboarding-step${step >= 2 ? " active" : ""}`} id="ob-step-2" aria-hidden={step >= 2 ? undefined : "true"}>
            <h2><span className="onboarding-num">2</span> Start the runner</h2>
            <p className="muted">Paste this into a terminal on the machine that will execute work. The token is pre-injected and scoped to <code>runner</code> only.</p>
            <div className="copy-row">
              <input id="ob-install" readOnly value={installCmd} aria-label="Install command" />
              <button className="button" type="button" onClick={() => copyText(installCmd, "Copied")}>Copy</button>
            </div>
            <p className="muted ob-poll-status" id="ob-poll-status">
              {online ? (
                <><span className="status online">●</span> Connected as <strong>{online.name}</strong></>
              ) : (
                "Waiting for runner to connect…"
              )}
            </p>
          </li>
          <li className={`onboarding-step${step >= 3 ? " active" : ""}`} id="ob-step-3" aria-hidden={step >= 3 ? undefined : "true"}>
            <h2><span className="onboarding-num">3</span> Run a sample workflow</h2>
            <p className="muted">Your runner is online. Pick a starter and trigger it — the run will appear on the home page.</p>
            <div className="grid ob-templates">
              {WORKFLOW_TEMPLATES.map((t) => <TemplateCard key={t.slug} template={t} />)}
            </div>
          </li>
        </ol>
        <p className="muted ob-skip">
          <a href="#runs" id="ob-skip" onClick={() => { sessionStorage.setItem("onboardingSkipped", "1"); }}>Skip the wizard — I'll wire this up later</a>
        </p>
      </section>
    </>
  );
}
