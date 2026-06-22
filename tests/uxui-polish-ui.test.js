import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the app-wide UX/UI polish pass: focused login chrome, an overflow-free
// Tokens layout, a calm Approvals empty state, the platform-stable support FAB,
// and FAB clearance for the last row of content. Content assertions on the
// shipped static assets, matching the rest of the browser-asset suite.
const root = process.cwd();
const appJs = readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");
const indexHtml = readFileSync(path.join(root, "public", "index.html"), "utf8");

describe("UX polish: login screen chrome is gated on auth", () => {
  it("defaults the body to logged-out and reveals nav only after auth", () => {
    assert.match(indexHtml, /<body class="logged-out">/);
    // bootAuthenticated must drop the gate; showAuthFallback must (re)apply it.
    const boot = appJs.slice(appJs.indexOf("function bootAuthenticated"));
    assert.match(boot.slice(0, 600), /classList\.remove\("logged-out"\)/);
    const fallback = appJs.slice(appJs.indexOf("function showAuthFallback"));
    assert.match(fallback.slice(0, 600), /classList\.add\("logged-out"\)/);
  });

  it("hides the primary nav + admin chrome while logged out", () => {
    assert.match(css, /body\.logged-out \.nav[\s\S]*?display:\s*none/);
    assert.match(css, /body\.logged-out \.mobile-primary-nav/);
  });
});

describe("UX polish: Tokens layout no longer overflows on desktop", () => {
  it("uses a balanced split (not the 1fr/380px main+rail) for peer panels", () => {
    assert.match(appJs, /class="split split-even"/);
    assert.match(css, /\.split-even\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    // Long monospace ids must wrap inside cells rather than widen the table.
    assert.match(css, /\.table \.muted\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  });
});

describe("UX polish: calm, consistent empty + FAB chrome", () => {
  it("renders Approvals empty state as a card, not bare muted text", () => {
    const fn = appJs.slice(appJs.indexOf("function approvalList"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    assert.match(body, /class="empty"/);
    assert.match(body, /No pending approvals/);
    // The old bare paragraph must be gone.
    assert.ok(!/return `<p class="muted">No pending approvals/.test(body), "empty state should be a card");
  });

  it("ships the support FAB as inline SVG (platform-stable, not an emoji)", () => {
    const fab = indexHtml.slice(indexHtml.indexOf('id="support-chat-fab"'));
    const btn = fab.slice(0, fab.indexOf("</button>"));
    assert.match(btn, /<svg/);
    assert.ok(!/✨/.test(btn), "FAB must not rely on the sparkle emoji");
  });

  it("clears the floating FAB so the last content row stays tappable on phones", () => {
    assert.match(css, /padding-bottom:\s*calc\(80px \+ env\(safe-area-inset-bottom\)\)/);
  });

  it("keeps inline icons from being squashed in flex chips", () => {
    assert.match(css, /\.ic\s*\{[\s\S]*?flex:\s*none/);
  });
});
