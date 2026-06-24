import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useMe, telegramAuthError, markTelegramWebAppReady } from "../lib/me.js";
import { toast } from "../lib/toast.js";
import { Shell } from "./Shell.jsx";

// Login screen — token-based fallback when there is no session and Telegram
// WebApp auth didn't apply. Mirrors the legacy #login panel markup/classes so
// styles.css applies unchanged.
function LoginScreen() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/auth/token-login", { method: "POST", body: { token } });
      // Re-run the boot query now that the session cookie is set.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (error) {
      toast(error.message || "Login failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="login" className="login">
      <section className="panel">
        <h1>Access Token</h1>
        {telegramAuthError ? (
          <p className="muted" id="telegram-auth-error">
            Telegram approval access failed: {telegramAuthError}
          </p>
        ) : null}
        <p className="muted">
          Use a Runyard access token issued by this machine. The first token is written to{" "}
          <code>data/bootstrap-token.txt</code> on server start.
        </p>
        <form id="login-form" className="form-grid" onSubmit={onSubmit}>
          <label>
            Token{" "}
            <input
              id="token"
              autoComplete="current-password"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Login"}
          </button>
        </form>
      </section>
    </main>
  );
}

function BootSplash() {
  return (
    <main className="login">
      <section className="panel">
        <p className="muted">Connecting…</p>
      </section>
    </main>
  );
}

// Top-level gate: decides between the boot splash, the login screen, and the
// authenticated Shell based on the /api/me boot query.
export function AuthGate() {
  const { data: me, isLoading, isError } = useMe();
  markTelegramWebAppReady();

  if (isLoading) return <BootSplash />;
  if (isError || !me) return <LoginScreen />;
  return <Shell me={me} />;
}
