# Goal: Brand system + UI minutia polish for the RunYard Hub

You are working in the git worktree at `/home/xiko/smithers-hub-worktrees/tanstack-react`
on branch **`feat/tanstack-react-ui`**, *after* the React + TanStack migration has completed.
The hub frontend is now a React app (built with esbuild, `pnpm build:web`). **Do NOT touch the
`main` worktree at `/home/xiko/smithers-hub`.** This is a **design/polish-only** pass — do not
change the server API, DB schema, or workflow behavior.

## Mission

Go over **every button, every pane, every page** and craft a tighter, calmer, more professional
UI with **strict brand compliance**. First define a brand system, then enforce it everywhere.

## Phase 1 — Establish the brand system (do this FIRST, commit it)

1. Create design tokens as the single source of truth (CSS custom properties + a small JS/TS
   token module if the build wants it). Define and name:
   - **Type scale**: a strict, limited set of font sizes (e.g. xs/sm/base/lg/xl/2xl) with exact
     px/rem values, line-heights, and weights. No ad-hoc font sizes anywhere after this.
   - **Font transformations**: where uppercase/letter-spacing/tabular-nums are allowed, and where
     they are not. Pick one display font + one mono font (for the console/logs) and stick to them.
   - **Color**: a small palette — background layers, text (primary/secondary/muted), border,
     and semantic colors (success/warn/danger/info/accent). Light/dark if the app supports it.
   - **Spacing scale**: a 4px (or 8px) base grid. All padding/margins snap to it.
   - **Radii, shadows, borders**: a small fixed set.
   - **Buttons**: define the *full* button system — variants (primary/secondary/ghost/danger),
     sizes (sm/md), shape/radius, the one canonical height per size, icon-button rules, and the
     rule for **how many primary buttons may appear in one view (ideally one)**.
2. Build a **`/brand` page** in the app: a living style guide that renders the type scale, colors,
   spacing, every button variant/size/state, badges, inputs, and the console style. This page IS
   the contract — it must always reflect the tokens. Link it somewhere discreet (footer/docs).
3. Refactor shared UI primitives (`ui.jsx` / Button / Badge / Card / etc.) to consume the tokens
   so the rest of the app inherits compliance for free.

## Phase 2 — Sweep every view for compliance + minutia

For each page/pane (Home/Runs, Run Detail + live console, Workflows + graph, Approvals, Runners,
Schedules, Agents, Tokens, Secrets, Audit, Settings, Connect/Onboarding, run form, support chat):
- **Align all fonts** to the type scale — kill every one-off size/weight.
- **Fix all overflow** — no horizontal scroll, no clipped text, no broken wrapping, at common
  widths (≈360, 768, 1280, 1680). Tables/long values truncate with ellipsis + tooltip or wrap
  deliberately.
- **Reduce density**: never too many buttons, never too much information on screen at once.
  - Demote secondary actions into overflow/`⋯` menus; keep at most one primary action per view.
  - **Progressive disclosure**: hide detail behind expandable sections, drawers, "show more",
    tabs, or popovers. Default to the *smallest* useful amount of info; let the user expand.
  - Establish a **clear visual hierarchy** on every page — one obvious primary heading/action,
    supporting info visibly secondary (muted color, smaller size, less weight).
- **Simplify and cut**: remove redundant labels, decorative chrome, repeated metadata, and
  anything that doesn't earn its place. Prefer whitespace over borders/boxes where it reads better.
- Consistent empty states, loading states, and error states using the shared primitives.

## UI/UX principles to apply (use your design judgment)

Visual hierarchy, restraint, and consistency over cleverness. Limited type scale, generous
whitespace, strong alignment to the spacing grid, one accent color used sparingly, semantic color
only for meaning. Progressive disclosure to fight density. Buttons: clear primary/secondary
distinction, never a wall of equal-weight buttons. Tabular numbers for IDs/metrics. Respect
reduced-motion. Keep the live console monospaced and readable. If a `frontend-design`,
`superdesign`, or `responsive` skill is available to you, use it; otherwise apply these directly.

## Eval gates — loop until all green before declaring done

- `pnpm build:web` clean, `pnpm build:vendor` clean.
- Backend suite stays green (`pnpm test`, must remain at least the migration's passing count, 0 fail).
- Hub boots (`pnpm start`); **every** page renders with **no console errors** and **no overflow**
  at 360 / 768 / 1280 / 1680 widths. Use the browser tooling to verify and **capture before/after
  screenshots of each page** into a `ui-polish-screens/` folder (gitignored or committed, your call).
- The `/brand` page renders and matches the tokens.

## Working rules

- Commit frequently with clear messages (brand tokens first, then per-view polish). Do NOT merge
  to main, tag, or deploy.
- It is fine to land this across many commits. Pace: brand system → primitives → view-by-view.
- When you stop, append a `UI-POLISH-STATUS.md`: what's compliant, what's left, gate status.
