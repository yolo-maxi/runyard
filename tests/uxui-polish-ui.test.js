import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the app-wide UX/UI polish pass for the React + TanStack frontend:
// focused login chrome (body gated on auth), an overflow-free Tokens layout, a
// calm Approvals empty state, the platform-stable support FAB, and FAB
// clearance for the last content row. UI structure is asserted on the web/
// React source; CSS rules on the (unchanged) styles.css; the body gate on
// index.html.
const root = process.cwd();
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");
const indexHtml = readFileSync(path.join(root, "public", "index.html"), "utf8");
const shell = readFileSync(path.join(root, "web", "app", "Shell.jsx"), "utf8");
const content = readFileSync(path.join(root, "web", "app", "Content.jsx"), "utf8");
const connect = readFileSync(path.join(root, "web", "views", "Connect.jsx"), "utf8");
const settings = readFileSync(path.join(root, "web", "views", "Settings.jsx"), "utf8");
const secrets = readFileSync(path.join(root, "web", "views", "Secrets.jsx"), "utf8");
const tokens = readFileSync(path.join(root, "web", "views", "Tokens.jsx"), "utf8");
const approvalList = readFileSync(path.join(root, "web", "components", "ApprovalList.jsx"), "utf8");
const supportChat = readFileSync(path.join(root, "web", "components", "SupportChat.jsx"), "utf8");

describe("UX polish: login screen chrome is gated on auth", () => {
  it("defaults the body to logged-out and reveals nav only after auth", () => {
    assert.match(indexHtml, /<body class="logged-out">/);
    // The authenticated Shell drops the gate on mount and re-applies it on
    // unmount (the React equivalent of bootAuthenticated/showAuthFallback).
    assert.match(shell, /classList\.remove\("logged-out"\)/);
    assert.match(shell, /classList\.add\("logged-out"\)/);
  });

  it("hides the primary nav + admin chrome while logged out", () => {
    assert.match(css, /body\.logged-out \.nav[\s\S]*?display:\s*none/);
    assert.match(css, /body\.logged-out \.mobile-primary-nav/);
  });
});

describe("UX polish: Tokens layout no longer overflows on desktop", () => {
  it("uses a balanced split (not the 1fr/380px main+rail) for peer panels", () => {
    assert.match(tokens, /split split-even/);
    assert.match(css, /\.split-even\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    // Long monospace ids must wrap inside cells rather than widen the table.
    assert.match(css, /\.table \.muted\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  });
});

describe("UX polish: simplified navigation groups related admin pages", () => {
  it("keeps Brand & UI routable without linking it in the admin menu", () => {
    assert.doesNotMatch(shell, /Brand &amp; UI/);
    assert.match(content, /view === "brand"[\s\S]*?<Brand \/>/);
  });

  it("routes Tokens through Connect and Secrets through Settings", () => {
    assert.match(shell, /\["connect", "Connect & Tokens"\]/);
    assert.match(shell, /\["settings", "Settings & Secrets"\]/);
    assert.doesNotMatch(shell, /\[\s*"tokens"\s*,/);
    assert.doesNotMatch(shell, /\[\s*"secrets"\s*,/);
    assert.match(content, /view === "connect" \|\| view === "tokens"[\s\S]*?<Connect \/>/);
    assert.match(content, /view === "secrets" \|\| view === "settings"[\s\S]*?<Settings \/>/);
    assert.match(connect, /<Tokens embedded \/>/);
    assert.match(settings, /<Secrets embedded \/>/);
  });
});

describe("UX polish: runner auth explains Claude token paste flow", () => {
  it("keeps Codex on device auth and Claude on local setup-token paste", () => {
    assert.match(secrets, /Re-auth Codex/);
    assert.match(secrets, /Connect Claude/);
    assert.match(secrets, /claude setup-token/);
    assert.match(secrets, /paste CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(secrets, /oauthTokenSecretName/);
    assert.match(secrets, /secretNames: \[secretName\]/);
  });
});

describe("UX polish: calm, consistent empty + FAB chrome", () => {
  it("renders Approvals empty state as a card, not bare muted text", () => {
    // The ApprovalList component renders the empty state inside a `.empty` card.
    assert.match(approvalList, /className="empty"/);
    assert.match(approvalList, /No pending approvals/);
    // The old bare `<p class="muted">No pending approvals` must be gone.
    assert.ok(!/<p className="muted">\s*No pending approvals/.test(approvalList), "empty state should be a card");
  });

  it("ships the support FAB as inline SVG (platform-stable, not an emoji)", () => {
    // The FAB renders an inline sparkle <svg> (a module constant), never the
    // sparkle emoji.
    assert.match(supportChat, /support-chat-fab/);
    assert.match(supportChat, /<svg/);
    assert.ok(!/✨/.test(supportChat), "FAB must not rely on the sparkle emoji");
  });

  it("clears the floating FAB so the last content row stays tappable on phones", () => {
    assert.match(css, /padding-bottom:\s*calc\(80px \+ env\(safe-area-inset-bottom\)\)/);
  });

  it("keeps inline icons from being squashed in flex chips", () => {
    assert.match(css, /\.ic\s*\{[\s\S]*?flex:\s*none/);
  });
});
