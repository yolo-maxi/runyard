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

// Breadcrumb trail. Ported from legacy breadcrumbs(). Items: {label, href?,
// title?, current?}.
export function Breadcrumbs({ items = [] }) {
  const visible = items.filter((i) => i?.label);
  if (!visible.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {visible.map((item, i) => (
          <li key={i}>
            {item.href ? (
              <a href={item.href} title={item.title || item.label} aria-current={item.current ? "page" : undefined}>
                {item.label}
              </a>
            ) : (
              <span title={item.title || item.label} aria-current={item.current ? "page" : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// Page toolbar with a title, optional share button, and action slot. Ported
// from legacy toolbar().
export function Toolbar({ title, shareHash = "", children }) {
  return (
    <div className="toolbar">
      <h1>
        {title}
        {shareHash ? <ShareButton hash={shareHash} label="Copy link to this page" /> : null}
      </h1>
      <div className="toolbar-actions">{children}</div>
    </div>
  );
}

// Pretty-printed JSON block. Ported from legacy json().
export function JsonBlock({ value }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

// ---- Token-driven Button primitive ---------------------------------------
// Wraps the CSS button system so views never hand-roll variant/size classes.
// variant: "secondary" (default) | "primary" | "danger" | "warning" | "ghost".
// size: "md" (default) | "sm". `icon` makes it a square icon-only button.
// Renders an <a> when `href` is supplied so links and buttons stay consistent.
export function Button({
  variant = "secondary",
  size = "md",
  icon = false,
  href,
  className = "",
  children,
  ...props
}) {
  const cls = [
    href ? "button" : "",
    variant !== "secondary" ? variant : "",
    size === "sm" ? "btn-sm" : "",
    icon ? "btn-icon" : "",
    className
  ]
    .filter(Boolean)
    .join(" ");
  if (href) {
    return (
      <a href={href} className={cls} {...props}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls || undefined} {...props}>
      {children}
    </button>
  );
}

// ---- Badge --------------------------------------------------------------
// Neutral-by-default pill for counts/labels. tone maps to a semantic color.
// (StatusBadge above is reserved for run/runner lifecycle states.)
export function Badge({ tone = "neutral", children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

// GitHub-style +additions/-deletions chip. Rendered inline anywhere run context
// is shown. Both halves render even when one is 0 so the shape stays consistent
// across cards; callers filter out null churn upstream so we never render
// "+0 -0" for runs that produced no diff.
export function CodeChurn({ churn, className = "" }) {
  if (!churn || typeof churn !== "object") return null;
  const additions = Number(churn.additions);
  const deletions = Number(churn.deletions);
  if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return null;
  const title = `${additions} line${additions === 1 ? "" : "s"} added, ${deletions} line${deletions === 1 ? "" : "s"} removed`;
  return (
    <span
      className={`code-churn${className ? ` ${className}` : ""}`}
      aria-label={title}
      title={title}
    >
      <span className="code-churn-add">+{additions}</span>
      <span className="code-churn-del">−{deletions}</span>
    </span>
  );
}

// ---- Card / Panel -------------------------------------------------------
// The standard surface container. `as` lets callers pick the element.
export function Card({ as: Tag = "div", className = "", children, ...props }) {
  return (
    <Tag className={`panel${className ? ` ${className}` : ""}`} {...props}>
      {children}
    </Tag>
  );
}

// ---- Overflow menu (⋯) --------------------------------------------------
// Collapses secondary actions behind a single trigger so toolbars stay calm.
// items: [{ label, onSelect?, href?, danger?, disabled? }] — falsy entries are
// skipped so callers can inline conditionals. Closes on selection / blur.
export function OverflowMenu({ items = [], label = "More actions", size = "md" }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  const close = (el) => el?.closest("details")?.removeAttribute("open");
  return (
    <details className="overflow-menu">
      <summary
        className={`button btn-icon${size === "sm" ? " btn-sm" : ""}`}
        aria-haspopup="menu"
        aria-label={label}
        title={label}
      >
        <span aria-hidden="true">⋯</span>
      </summary>
      <div className="overflow-menu-list" role="menu">
        {visible.map((item, i) =>
          item.href ? (
            <a
              key={i}
              href={item.href}
              role="menuitem"
              className={item.danger ? "is-danger" : undefined}
              onClick={(e) => close(e.currentTarget)}
            >
              {item.label}
            </a>
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={item.danger ? "is-danger" : undefined}
              onClick={(e) => {
                close(e.currentTarget);
                item.onSelect?.(e);
              }}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </details>
  );
}

// ---- Empty / Loading states ---------------------------------------------
// Shared so every view's "nothing here" / "loading" reads identically.
export function EmptyState({ title, children, actions }) {
  return (
    <div className="empty">
      {title ? <p className="empty-title">{title}</p> : null}
      {children}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Spinner({ label = "Loading…", inline = false }) {
  return (
    <span className={`spinner${inline ? " spinner-inline" : ""}`} role="status">
      <span className="spinner-dot" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
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
