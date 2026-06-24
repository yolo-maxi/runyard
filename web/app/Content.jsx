import { useHashRoute } from "../lib/router.js";
import { Placeholder } from "../views/Placeholder.jsx";

// Route → view dispatch, mirroring the legacy render() switch in app.js. Views
// are swapped from Placeholder to their real React component as each migration
// phase lands. Keeping the full route table here from day one means every
// deep link resolves to *something* (never a blank screen).
export function Content({ me }) {
  const route = useHashRoute();
  const { view, segments } = route;

  if (view === "runs" && segments[1]) {
    return <Placeholder title="Run detail" note={`Run ${segments[1]} — porting in progress.`} />;
  }
  if (view === "home" || view === "runs" || view === "dashboard") {
    return <Placeholder title="Runs" />;
  }
  if (view === "workflows" || view === "capabilities") {
    return segments[1] ? (
      <Placeholder title="Workflow detail" note={`${segments[1]} — porting in progress.`} />
    ) : (
      <Placeholder title="Workflows" />
    );
  }
  if (view === "agents" || view === "skills" || view === "knowledge") {
    return <Placeholder title="Agents / Skills / Knowledge" />;
  }
  if (view === "connect") return <Placeholder title="Connect" />;
  if (view === "onboarding") return <Placeholder title="Get started" />;
  if (view === "approvals") {
    return segments[1] ? (
      <Placeholder title="Approval detail" />
    ) : (
      <Placeholder title="Approvals" />
    );
  }
  if (view === "runners") return <Placeholder title="Runners" />;
  if (view === "schedules") {
    return segments[1] ? <Placeholder title="Schedule detail" /> : <Placeholder title="Schedules" />;
  }
  if (view === "tokens") return <Placeholder title="Tokens" />;
  if (view === "audit") return <Placeholder title="Audit" />;
  if (view === "secrets") return <Placeholder title="Secrets" />;
  if (view === "settings") return <Placeholder title="Settings" />;
  return <Placeholder title="Runs" />;
}
