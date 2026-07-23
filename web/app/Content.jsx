import { useHashRoute } from "../lib/router.js";
import { meIsAdmin } from "../lib/me.js";
import { Placeholder } from "../views/Placeholder.jsx";
import { Home } from "../views/Home.jsx";
import { RunDetail } from "../views/RunDetail.jsx";
import { Audit } from "../views/Audit.jsx";
import { Settings } from "../views/Settings.jsx";
import { Approvals, ApprovalDetail } from "../views/Approvals.jsx";
import { Runners } from "../views/Runners.jsx";
import { Agents } from "../views/Agents.jsx";
import { Connect } from "../views/Connect.jsx";
import { Onboarding } from "../views/Onboarding.jsx";
import { Schedules, ScheduleDetail } from "../views/Schedules.jsx";
import { Workflows } from "../views/Workflows.jsx";
import { WorkflowDetail } from "../views/WorkflowDetail.jsx";
import { WorkBoard } from "../views/WorkBoard.jsx";
import { WorkItemDetail } from "../views/WorkItemDetail.jsx";
import { Brand } from "../views/Brand.jsx";
import { Repositories, RepositoryDetail } from "../views/Repositories.jsx";

// Views reachable only with an admin-scoped session. Deep links still resolve
// for non-admins, but to an honest notice instead of forms that would 403.
const ADMIN_VIEWS = new Set(["connect", "tokens", "runners", "audit", "secrets", "settings", "brand"]);

function AdminOnly() {
  return (
    <section className="panel">
      <div className="empty">
        <p>Admin only.</p>
        <p className="muted">
          This page manages the deployment. Sign in with an admin-scoped token
          to use it.
        </p>
      </div>
    </section>
  );
}

// Route → view dispatch, mirroring the legacy render() switch in app.js. Views
// are swapped from Placeholder to their real React component as each migration
// phase lands. Keeping the full route table here from day one means every
// deep link resolves to *something* (never a blank screen).
export function Content({ me }) {
  const route = useHashRoute();
  const { view, segments } = route;

  if (ADMIN_VIEWS.has(view) && !meIsAdmin(me)) return <AdminOnly />;

  if (view === "runs" && segments[1]) {
    const focus = segments[2] || ""; // "logs" | "artifacts" | ""
    return <RunDetail key={segments[1]} runId={segments[1]} focus={focus} />;
  }
  if (view === "home" || view === "runs" || view === "dashboard") {
    return <Home />;
  }
  if (view === "work") {
    // #work → board, #work/:id → ticket detail, #work/:id/flow → detail
    // scrolled to the execution-flow section.
    if (!segments[1]) return <WorkBoard />;
    return <WorkItemDetail key={segments[1]} id={segments[1]} focus={segments[2] || ""} me={me} />;
  }
  if (view === "workflows" || view === "workflows") {
    return segments[1] ? (
      <WorkflowDetail key={segments[1]} slug={segments[1]} sub={segments[2] || ""} />
    ) : (
      <Workflows />
    );
  }
  if (view === "agents" || view === "skills" || view === "knowledge") {
    const tab = view === "agents" ? segments[1] || "agents" : view;
    const slug = view === "agents" ? segments[2] : segments[1];
    return <Agents tab={tab} slug={slug} />;
  }
  if (view === "connect" || view === "tokens") return <Connect />;
  if (view === "onboarding") return <Onboarding />;
  if (view === "approvals") {
    return segments[1] ? <ApprovalDetail key={segments[1]} id={segments[1]} /> : <Approvals />;
  }
  if (view === "runners") return <Runners />;
  if (view === "repositories") {
    // #repositories → CI overview, #repositories/:id → repository detail.
    return segments[1]
      ? <RepositoryDetail key={segments[1]} id={segments[1]} me={me} />
      : <Repositories me={me} />;
  }
  if (view === "schedules") {
    return segments[1] ? <ScheduleDetail key={segments[1]} id={segments[1]} /> : <Schedules />;
  }
  if (view === "audit") return <Audit />;
  if (view === "secrets" || view === "settings") return <Settings />;
  if (view === "brand") return <Brand />;
  return <Placeholder title="Runs" />;
}
