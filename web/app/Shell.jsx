import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHashRoute, useNavigate } from "../lib/router.js";
import { api } from "../lib/api.js";
import { meIsAdmin } from "../lib/me.js";
import { useSidebarBadges } from "../lib/badges.js";
import { EnvChip } from "./EnvChip.jsx";
import { Content } from "./Content.jsx";
import { UpdateBadge } from "../components/UpdateBadge.jsx";
import { SupportChat } from "../components/SupportChat.jsx";
import { Icon } from "../components/ui.jsx";

// Small count badge — hidden when zero, matching legacy .nav-badge behavior.
function NavBadge({ kind, count }) {
  return (
    <span className="nav-badge" data-badge={kind} hidden={!count} title={`${count} need attention`}>
      {count || ""}
    </span>
  );
}

// Maps any route view to its highlighted primary nav item (sidebar + mobile),
// ported from PRIMARY_VIEWS in app.js.
const PRIMARY_VIEWS = new Map([
  ["home", "home"],
  ["runs", "home"],
  ["dashboard", "home"],
  ["workflows", "workflows"],
  ["workflows", "workflows"],
  ["schedules", "schedules"],
  ["approvals", "approvals"],
  ["agents", "agents"],
  ["skills", "agents"],
  ["knowledge", "agents"]
]);

const ADMIN_LINKS = [
  ["connect", "Connect & Tokens"],
  ["runners", "Runners"],
  ["audit", "Audit"],
  ["settings", "Settings & Secrets"]
];

function SidebarButton({ view, primary, label, current }) {
  const navigate = useNavigate();
  const active = primary === current;
  return (
    <button
      data-view={view}
      className={active ? "active" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate(`#${view}`)}
    >
      {label}
    </button>
  );
}

function ApprovalNotificationLink({ count = 0, active = false }) {
  const label = count
    ? `${count} approval${count === 1 ? "" : "s"} need checking`
    : "Approvals";
  return (
    <a
      className={`button btn-icon approval-notifications${active ? " active" : ""}`}
      href="#approvals"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      data-has-pending={count > 0 ? "true" : "false"}
    >
      <Icon name="bell" size="18" />
      <span className="approval-notifications-dot" aria-hidden="true" hidden={!count} />
    </a>
  );
}

export function Shell({ me }) {
  const route = useHashRoute();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const current = PRIMARY_VIEWS.get(route.view) || "";
  const admin = meIsAdmin(me);
  const badges = useSidebarBadges();

  // Reveal the authenticated chrome (login screen sets body.logged-out).
  useEffect(() => {
    document.body.classList.remove("logged-out");
    return () => document.body.classList.add("logged-out");
  }, []);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      queryClient.clear();
      location.reload();
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Runyard</span>
          <span className="brand-pill" title="Runyard Hub — the control plane">
            Hub
          </span>
          <EnvChip />
        </div>
        <nav className="mobile-primary-nav" aria-label="Primary navigation">
          <a href="#runs" data-primary-view="home" className={current === "home" ? "active" : undefined}>
            Runs<NavBadge kind="runs" count={badges.runs} />
          </a>
          <a href="#workflows" data-primary-view="workflows" className={current === "workflows" ? "active" : undefined}>
            Workflows
          </a>
          <a href="#schedules" data-primary-view="schedules" className={current === "schedules" ? "active" : undefined}>
            Schedules
          </a>
          <a href="#agents/agents" data-primary-view="agents" className={current === "agents" ? "active" : undefined}>
            Agents
          </a>
        </nav>
        <nav className="nav" aria-label="Support and admin">
          <a className="button support-link" href="/docs#deep-links" title="Every URL in the Hub is shareable — see Docs.">
            Docs
          </a>
          <a className="button support-link" href="/llms.txt">
            llms.txt
          </a>
          <UpdateBadge me={me} />
          <ApprovalNotificationLink count={badges.approvals} active={route.view === "approvals"} />
          {/* Admin pages are for admin-scoped sessions only (the API enforces
              this; the menu just stops advertising levers that would 403).
              Non-admins keep a mobile-only "More" menu for the Docs links the
              phone topbar hides. */}
          <details className={admin ? "admin-menu" : "admin-menu mobile-menu-only"} id="admin-menu">
            <summary className="button" aria-haspopup="true">
              <span className="admin-label-full">{admin ? "Admin" : "More"}</span>
              <span className="admin-label-short">More</span> <span aria-hidden="true">▾</span>
            </summary>
            <div className="admin-menu-list" role="menu">
              <a className="mobile-menu-only" href="/docs#deep-links" role="menuitem">
                Docs
              </a>
              <a className="mobile-menu-only" href="/llms.txt" role="menuitem">
                llms.txt
              </a>
              {(admin ? ADMIN_LINKS : []).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    navigate(`#${view}`);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
          <button id="logout" onClick={logout}>
            Logout
          </button>
        </nav>
      </header>
      <main id="app" className="shell">
        <nav className="sidebar" aria-label="Primary navigation">
          <SidebarButton view="home" primary="home" label="Runs" current={current} />
          <SidebarButton view="workflows" primary="workflows" label="Workflows" current={current} />
          <SidebarButton view="schedules" primary="schedules" label="Schedules" current={current} />
          <SidebarButton view="agents" primary="agents" label="Agents" current={current} />
        </nav>
        <section id="content" className="content">
          <Content me={me} />
        </section>
      </main>
      <SupportChat me={me} />
    </>
  );
}
