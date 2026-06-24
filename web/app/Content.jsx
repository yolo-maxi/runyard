import { useHashRoute } from "../lib/router.js";
import { Placeholder } from "../views/Placeholder.jsx";
import { Home } from "../views/Home.jsx";
import { RunDetail } from "../views/RunDetail.jsx";
import { Audit } from "../views/Audit.jsx";
import { Settings } from "../views/Settings.jsx";
import { Approvals, ApprovalDetail } from "../views/Approvals.jsx";
import { Runners } from "../views/Runners.jsx";
import { Tokens } from "../views/Tokens.jsx";
import { Agents } from "../views/Agents.jsx";
import { Connect } from "../views/Connect.jsx";
import { Onboarding } from "../views/Onboarding.jsx";

// Route → view dispatch, mirroring the legacy render() switch in app.js. Views
// are swapped from Placeholder to their real React component as each migration
// phase lands. Keeping the full route table here from day one means every
// deep link resolves to *something* (never a blank screen).
export function Content({ me }) {
  const route = useHashRoute();
  const { view, segments } = route;

  if (view === "runs" && segments[1]) {
    const focus = segments[2] || ""; // "logs" | "artifacts" | ""
    return <RunDetail key={segments[1]} runId={segments[1]} focus={focus} />;
  }
  if (view === "home" || view === "runs" || view === "dashboard") {
    return <Home />;
  }
  if (view === "workflows" || view === "capabilities") {
    return segments[1] ? (
      <Placeholder title="Workflow detail" note={`${segments[1]} — porting in progress.`} />
    ) : (
      <Placeholder title="Workflows" />
    );
  }
  if (view === "agents" || view === "skills" || view === "knowledge") {
    const tab = view === "agents" ? segments[1] || "agents" : view;
    const slug = view === "agents" ? segments[2] : segments[1];
    return <Agents tab={tab} slug={slug} />;
  }
  if (view === "connect") return <Connect />;
  if (view === "onboarding") return <Onboarding />;
  if (view === "approvals") {
    return segments[1] ? <ApprovalDetail key={segments[1]} id={segments[1]} /> : <Approvals />;
  }
  if (view === "runners") return <Runners />;
  if (view === "schedules") {
    return segments[1] ? <Placeholder title="Schedule detail" /> : <Placeholder title="Schedules" />;
  }
  if (view === "tokens") return <Tokens />;
  if (view === "audit") return <Audit />;
  if (view === "secrets") return <Placeholder title="Secrets" />;
  if (view === "settings") return <Settings />;
  return <Placeholder title="Runs" />;
}
