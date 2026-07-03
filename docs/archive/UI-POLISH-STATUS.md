# UI Brand & Polish — Status

Branch: `feat/tanstack-react-ui`. Design/polish-only pass on the React + TanStack
Hub frontend (built with `pnpm build:web`). No server API, DB schema, or workflow
behaviour was changed.

## Gate status

| Gate | Status |
| --- | --- |
| `pnpm build:web` | ✅ clean |
| `pnpm build:vendor` | ✅ clean |
| `pnpm test` | ✅ 384 pass / 0 fail (baseline was 384/0) |
| Hub boots (`pnpm start`) | ✅ boots; every page renders authenticated |
| No horizontal overflow @ 360 / 768 / 1280 / 1680 | ✅ **0 overflow across 14 pages × 4 widths** (56 captures) |
| No console errors from the UI | ✅ none from the UI (see *Known pre-existing* below) |
| `/brand` renders & matches tokens | ✅ renders the live tokens via `getComputedStyle` |

Overflow + console checks are reproducible: `node scripts/ui-audit.mjs <label>`
drives headless Chromium over the DevTools Protocol (auth cookie, the four
widths, overflow probe, console capture, screenshots → `ui-polish-screens/<label>/`).
The machine-readable result is `ui-polish-screens/after/_report.json`.

## Phase 1 — Brand system (done)

- **Design tokens** are the single source of truth in `public/styles.css` `:root`:
  - **Type scale** — strict 8 steps (`--fs-2xs`…`--fs-2xl`) + `--fs-display`, each
    paired with a line-height. Every ad-hoc `font-size` in the stylesheet (16
    distinct values) was migrated to the scale; **no raw px font sizes remain**.
  - **Weights** — `--fw-normal/medium/semibold/bold/display`; all raw weights migrated.
  - **Fonts** — one display (`--font-sans`, Inter) + one mono (`--font-mono`) token;
    all literal font-family declarations consolidated.
  - **Color** — background layers, text (primary/secondary/muted), border, one
    accent (green) + one link (blue), and semantic tones (success/warn/danger/info)
    with fg/bg/border each. Legacy var names kept as aliases so the whole sheet
    inherits the palette.
  - **Spacing** — 4px-grid scale (`--space-*`); **Radii / shadows / borders** — small fixed sets.
  - **Buttons** — full system: secondary default + `primary`/`danger`/`warning`/`ghost`
    variants, `sm`/`md` sizes (canonical 30/36px heights), `btn-icon` rule,
    focus-visible rings. Rule documented in CSS + on `/brand`: **at most one primary per view**.
  - `prefers-reduced-motion` honoured globally.
- **`/brand` page** (`web/views/Brand.jsx`, route `#brand`) — living style guide
  reading tokens from the live `:root`. Renders type scale, weights, colors,
  spacing, radii/shadows, the full button matrix + states, badges, run-status
  pills, form/loading/error states, and the console style. Linked discreetly from
  the top More/Admin menu.
- **Shared primitives** (`web/components/ui.jsx`) refactored/added to consume tokens:
  `Button`, `Badge`, `Card`, `OverflowMenu` (⋯), `Spinner`, `EmptyState` (plus the
  existing `StatusBadge`/`Toolbar`/`Breadcrumbs`).

## Phase 2 — View sweep (in progress)

Compliant **for free** via the token migration: every view now draws fonts,
weights, colors, and buttons from the scale/palette — one-off sizes and raw hexes
no longer reach the rendered UI through the shared stylesheet.

Targeted density / hierarchy fixes landed:

- **RunCard** — 5-button footer → one `Re-run` action + a ⋯ overflow menu
  (Edit & re-run / Run log / Artifacts). Redundant `Workflow` button removed.
- **WorkflowCard** — dropped redundant `Open` (title links there); one accent
  `Run` + ⋯ menu (Open / Edit).
- **Agent / Skill cards** — dropped redundant `Open`; single `Edit` action.
- **Home** — empty-state CTAs demoted to secondary so the `PrimaryActionBar` owns
  the one primary action on the view.
- **RunDetail / RunBanner** — already exemplary (progressive-disclosure sections
  with status-aware defaults; one primary `Re-run` + `More ▾` overflow incl. the
  danger Cancel). Left as the reference pattern.

Verified visually at 1280 (and structurally at all four widths): Runs, Run detail,
Workflows, Workflow detail, Approvals, Runners, Schedules, Agents, Tokens, Secrets,
Audit, Settings, Connect, `/brand`.

## Known pre-existing (out of scope — design-only pass)

These appeared in the console capture and are **not** from this pass; they live in
the data/server layer which this pass must not touch:

- `@tanstack/query-db-collection: queryFn must return an array of objects. Got:
  object for queryKey ["approvals"]` — approvals collection shape warning
  (intermittent). Pre-existing from the migration.
- `secrets` returns **503** when `SECRETS_ENC_KEY` is unset — by design (feature
  disabled), not a bug.
- A transient `404` resource on first Runs load.

## What's left / next

- Optional: migrate remaining raw hex *background tints* in `styles.css` to the
  semantic `--*-bg/--*-border` tokens (functionally identical today; would tighten
  the contract further).
- Optional: refactor the hand-rolled overflow menus (RunBanner, admin menu) onto
  the shared `OverflowMenu` primitive for one menu implementation.
- A true *before* screenshot set was not captured (the authenticated capture
  harness came online after Phase 1 had landed); the committed `ui-polish-screens/`
  set is the verified *after* state.
