import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { Toolbar, JsonBlock, StatusBadge } from "../components/ui.jsx";

// Deployment settings + Telegram approval status (admin). Ported from
// renderSettings().
export function Settings() {
  const { data: setup, isLoading } = useQuery({ queryKey: ["setup"], queryFn: () => api("/api/setup") });
  return (
    <>
      <Toolbar title="Settings" shareHash={deepLinks.settings()} />
      <section className="split">
        <div className="panel">
          <h2>Deployment</h2>
          {isLoading ? <p className="muted">Loading…</p> : <JsonBlock value={setup} />}
        </div>
        <div className="panel">
          <h2>Telegram Approvals</h2>
          <p><StatusBadge value={setup?.telegramConfigured ? "online" : "pending"} /></p>
          <p className="muted">
            Set <code>TELEGRAM_BOT_TOKEN</code> and preferred private DM target{" "}
            <code>TELEGRAM_APPROVAL_CHAT_ID</code>. Legacy <code>TELEGRAM_CHAT_ID</code>/
            <code>TELEGRAM_THREAD_ID</code> remains a fallback for non-approval chat routing. Web, API,
            CLI, and MCP approvals work without Telegram.
          </p>
        </div>
      </section>
    </>
  );
}
