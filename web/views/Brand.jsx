import { useEffect, useState } from "react";
import { Toolbar, Button, Badge, OverflowMenu, Spinner, EmptyState, StatusBadge } from "../components/ui.jsx";

// Living style guide. Every value shown here is read from the live :root
// custom properties (getComputedStyle), so the page is a true contract: if a
// token changes, this page changes with it. Nothing on this page should hard-
// code a px size or hex color — it renders the tokens themselves.

function useTokens(names) {
  const [vals, setVals] = useState({});
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    setVals(out);
    // names is a stable module-level constant per section, safe to ignore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return vals;
}

const TYPE_STEPS = [
  ["--fs-2xs", "--lh-2xs", "2xs", "Micro labels, pill text, timestamps"],
  ["--fs-xs", "--lh-xs", "xs", "Captions, secondary meta"],
  ["--fs-sm", "--lh-sm", "sm", "Dense body, table cells"],
  ["--fs-base", "--lh-base", "base", "Default UI text, buttons, inputs"],
  ["--fs-md", "--lh-md", "md", "Lead paragraph, card titles"],
  ["--fs-lg", "--lh-lg", "lg", "Section headings"],
  ["--fs-xl", "--lh-xl", "xl", "Page sub-titles"],
  ["--fs-2xl", "--lh-2xl", "2xl", "Page H1"]
];
const TYPE_TOKENS = TYPE_STEPS.flatMap(([fs, lh]) => [fs, lh]);

function TypeScale() {
  const t = useTokens(TYPE_TOKENS);
  return (
    <div className="brand-type">
      {TYPE_STEPS.map(([fs, lh, name, use]) => (
        <div className="brand-type-row" key={fs}>
          <div className="brand-type-meta">
            <code className="brand-token">{fs}</code>
            <span className="muted">
              {t[fs]} / {t[lh]}
            </span>
            <span className="muted">{use}</span>
          </div>
          <p className="brand-type-sample" style={{ fontSize: `var(${fs})`, lineHeight: `var(${lh})` }}>
            The quick brown fox — {name}
          </p>
        </div>
      ))}
    </div>
  );
}

const WEIGHTS = [
  ["--fw-normal", "Normal", "Body copy"],
  ["--fw-medium", "Medium", "Buttons, emphasis"],
  ["--fw-semibold", "Semibold", "Headings, labels"],
  ["--fw-bold", "Bold", "Strong emphasis (rare)"]
];

function Weights() {
  return (
    <div className="brand-weights">
      {WEIGHTS.map(([tok, name, use]) => (
        <div className="brand-weight-row" key={tok}>
          <span style={{ fontWeight: `var(${tok})`, fontSize: "var(--fs-md)" }}>{name}</span>
          <code className="brand-token">{tok}</code>
          <span className="muted">{use}</span>
        </div>
      ))}
    </div>
  );
}

const COLOR_GROUPS = [
  [
    "Surfaces",
    [
      ["--bg", "Canvas"],
      ["--surface", "Panels / cards"],
      ["--surface-2", "Soft fills"],
      ["--surface-3", "Table headers"]
    ]
  ],
  [
    "Text",
    [
      ["--text", "Primary"],
      ["--text-secondary", "Secondary"],
      ["--text-muted", "Muted"]
    ]
  ],
  [
    "Accent & link",
    [
      ["--accent", "Accent (primary)"],
      ["--accent-hover", "Accent hover"],
      ["--accent-tint", "Accent tint"],
      ["--link", "Link"]
    ]
  ],
  [
    "Borders",
    [
      ["--border", "Border"],
      ["--border-strong", "Border strong"]
    ]
  ],
  [
    "Semantic",
    [
      ["--success", "Success"],
      ["--warn-fg", "Warn"],
      ["--danger-fg", "Danger"],
      ["--info-fg", "Info"]
    ]
  ]
];
const COLOR_TOKENS = COLOR_GROUPS.flatMap(([, swatches]) => swatches.map(([tok]) => tok));

function Colors() {
  const t = useTokens(COLOR_TOKENS);
  return (
    <div className="brand-color-groups">
      {COLOR_GROUPS.map(([group, swatches]) => (
        <div className="brand-color-group" key={group}>
          <h3 className="brand-subhead">{group}</h3>
          <div className="brand-swatches">
            {swatches.map(([tok, label]) => (
              <div className="brand-swatch" key={tok}>
                <span className="brand-swatch-chip" style={{ background: `var(${tok})` }} />
                <span className="brand-swatch-label">{label}</span>
                <code className="brand-token">{tok}</code>
                <span className="muted brand-swatch-hex">{t[tok]}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const SPACES = ["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-8", "--space-10", "--space-12"];

function Spacing() {
  const t = useTokens(SPACES);
  return (
    <div className="brand-spacing">
      {SPACES.map((tok) => (
        <div className="brand-space-row" key={tok}>
          <code className="brand-token">{tok}</code>
          <span className="muted brand-space-val">{t[tok]}</span>
          <span className="brand-space-bar" style={{ width: `var(${tok})` }} />
        </div>
      ))}
    </div>
  );
}

const RADII = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-pill"];
const SHADOWS = ["--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg"];

function RadiiShadows() {
  return (
    <div className="brand-rs">
      <div>
        <h3 className="brand-subhead">Radii</h3>
        <div className="brand-rs-row">
          {RADII.map((tok) => (
            <div className="brand-rs-tile" key={tok}>
              <span className="brand-rs-box" style={{ borderRadius: `var(${tok})` }} />
              <code className="brand-token">{tok}</code>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="brand-subhead">Shadows</h3>
        <div className="brand-rs-row">
          {SHADOWS.map((tok) => (
            <div className="brand-rs-tile" key={tok}>
              <span className="brand-rs-box brand-rs-shadow" style={{ boxShadow: `var(${tok})` }} />
              <code className="brand-token">{tok}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Buttons() {
  return (
    <div className="brand-buttons">
      <p className="muted brand-rule">
        At most <strong>one</strong> primary (solid-accent) button per view. Everything else is
        secondary, ghost, or collapsed into an overflow menu.
      </p>
      <div className="brand-btn-grid">
        <div className="brand-btn-col">
          <span className="brand-subhead">Medium (default)</span>
          <div className="brand-btn-row">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </div>
          <div className="brand-btn-row">
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button disabled>Disabled</Button>
            <OverflowMenu
              items={[
                { label: "Duplicate" },
                { label: "Export" },
                { label: "Delete", danger: true }
              ]}
            />
          </div>
        </div>
        <div className="brand-btn-col">
          <span className="brand-subhead">Small</span>
          <div className="brand-btn-row">
            <Button variant="primary" size="sm">
              Primary
            </Button>
            <Button size="sm">Secondary</Button>
            <Button variant="ghost" size="sm">
              Ghost
            </Button>
            <Button variant="danger" size="sm">
              Danger
            </Button>
            <OverflowMenu size="sm" items={[{ label: "Rename" }, { label: "Remove", danger: true }]} />
          </div>
        </div>
      </div>
    </div>
  );
}

const STATUSES = ["succeeded", "running", "queued", "waiting_approval", "failed", "cancelled", "superseded"];

function BadgesAndStatuses() {
  return (
    <div className="brand-badges">
      <div>
        <h3 className="brand-subhead">Badges</h3>
        <div className="brand-badge-row">
          <Badge>neutral</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warn">warn</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
        </div>
      </div>
      <div>
        <h3 className="brand-subhead">Run status pills</h3>
        <div className="brand-badge-row">
          {STATUSES.map((s) => (
            <StatusBadge key={s} value={s} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FormsAndStates() {
  return (
    <div className="brand-forms">
      <label className="brand-field">
        <span>Text input</span>
        <input type="text" placeholder="Placeholder text" defaultValue="Editable value" />
      </label>
      <label className="brand-field">
        <span>Select</span>
        <select defaultValue="b">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
        </select>
      </label>
      <label className="brand-field">
        <span>Textarea</span>
        <textarea placeholder="Multi-line input" rows={2} />
      </label>
      <div className="brand-field">
        <span>States</span>
        <div className="brand-state-row">
          <Spinner label="Loading…" />
          <span className="field-error">Inline error message</span>
        </div>
      </div>
    </div>
  );
}

function ConsoleSample() {
  return (
    <pre className="json brand-console">{`[12:04:01] ▶ run started  workflow=smart-contract-audit
[12:04:02] · cloning repo …
[12:04:09] ✓ checkout @ a1b2c3d
[12:04:11] ⚠ rate-limit: retrying in 2s
[12:04:18] ✓ audit complete — 0 critical, 3 advisory`}</pre>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="brand-section">
      <header className="brand-section-head">
        <h2>{title}</h2>
        {hint ? <p className="muted">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function Brand() {
  return (
    <div className="brand-page">
      <Toolbar title="Brand & UI system" shareHash="#brand" />
      <p className="brand-lede muted">
        The living contract for Runyard's interface. Every token below is read from the live
        stylesheet — this page <em>is</em> the source of truth. No view may introduce a font size,
        color, or spacing value that does not appear here.
      </p>

      <Section title="Type scale" hint="Eight steps. Display is reserved for marketing/hero surfaces.">
        <TypeScale />
      </Section>

      <Section title="Weights" hint="Four weights. Uppercase + letter-spacing is allowed only on micro-labels.">
        <Weights />
      </Section>

      <Section title="Color" hint="Background layers, text, one accent, one link, semantic tones.">
        <Colors />
      </Section>

      <Section title="Spacing" hint="4px base grid. All padding and margins snap to it.">
        <Spacing />
      </Section>

      <Section title="Radii & shadows" hint="A small fixed set.">
        <RadiiShadows />
      </Section>

      <Section title="Buttons" hint="Two sizes · four variants · one primary per view.">
        <Buttons />
      </Section>

      <Section title="Badges & status" hint="Semantic color carries meaning, never decoration.">
        <BadgesAndStatuses />
      </Section>

      <Section title="Forms & states" hint="Inputs, loading, and error states share one look.">
        <FormsAndStates />
      </Section>

      <Section title="Console" hint="Monospace, dark surface, readable at a glance.">
        <ConsoleSample />
      </Section>
    </div>
  );
}
