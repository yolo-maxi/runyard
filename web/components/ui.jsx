import { deepLinks } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";

// Inline monochrome icons ported from legacy ICON_PATHS — render identically on
// every platform (unlike emoji) and inherit currentColor.
const ICON_PATHS = {
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M12 8.5 13 11l2.5 1-2.5 1-1 2.5-1-2.5L8.5 12 11 11z"/>',
  queue: '<path d="M6 2h12M6 22h12"/><path d="M7 2c0 4 3 5 5 7 2-2 5-3 5-7M7 22c0-4 3-5 5-7 2 2 5 3 5 7"/>',
  runner: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><line x1="6.5" y1="7" x2="6.5" y2="7"/><line x1="6.5" y1="17" x2="6.5" y2="17"/>',
  free: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.2 2.2L15.5 9.5"/>',
  project: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-4 4.5-8 4.5"/>'
};

export function Icon({ name, cls = "", size = "1em" }) {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg
      className={`ic${cls ? ` ${cls}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

const STATUS_ICONS = {
  succeeded: "✅", failed: "❌", error: "❌", cancelled: "🛑", recovered: "↩",
  superseded: "↪", rejected: "⛔", running: "▶", assigned: "🧭", queued: "⏳",
  pending: "⏳", waiting_approval: "✋", approved: "✅", online: "●", offline: "○"
};

// Status pill — mirrors legacy status() markup/classes for styles.css.
export function StatusBadge({ value }) {
  const key = String(value || "").toLowerCase();
  const glyph = STATUS_ICONS[key] || "•";
  return (
    <span className={`status ${key}`}>
      <span aria-hidden="true">{glyph}</span> {value}
    </span>
  );
}

// Inline "copy share link" button — emits an absolute URL for the given hash.
export function ShareButton({ hash, label = "Copy link" }) {
  const url = deepLinks.abs(hash);
  return (
    <button
      type="button"
      className="share-link"
      title="Copy shareable link"
      aria-label={label}
      onClick={() => copyText(url, "Link copied")}
    >
      <Icon name="link" />
    </button>
  );
}
