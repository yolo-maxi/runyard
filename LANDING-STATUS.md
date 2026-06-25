# Landing redesign — status

Branch: `feat/landing-redesign` · scope: **design + copy on a single static page**
(`public/landing.html`). No server/API/app logic touched.

## What changed

- **Rewrote `public/landing.html`** from the ground up as a modern, brand-consistent
  marketing page. All new CSS lives in a single scoped `<style>` block that resolves to the
  existing design tokens in `public/styles.css` (`--fs-*`, `--space-*`, `--accent`, `--ink`,
  `--surface`, radii, shadows, motion) and reuses the shared `.button` / `.button.primary` /
  `.brand` primitives. **`styles.css` was not modified**, so the app and `pnpm build:web` are
  unaffected.

### Page structure
1. **Topbar** — brand wordmark + nav: Docs, GitHub, and the single primary CTA **Open the hub →**
   (`/app`).
2. **Hero** — eyebrow pill, one-line value prop (“A control plane for AI agent runs — on your own
   machines.”), supporting sub, primary CTA (`/app`) + secondary (`/docs`), and a footnote with
   GitHub + `llms.txt`. Paired with a **dark console proof card** (uses the `--console-bg/fg`
   brand tokens) showing a live run tail with an approval gate — a concrete demo of the
   “full visibility” differentiator.
3. **Value strip** — five at-a-glance proof points.
4. **How it works** — a three-column hub + runners flow (Agents & people → **The hub** → Delegated
   runners) with the hub node visually emphasised, connector arrows that rotate to vertical when
   the flow stacks, and a note that the engine under the hood is **Smithers**
   (`smithers-orchestrator`).
5. **Features grid** — the real, truthful differentiators: durable & crash-safe, full visibility,
   human-in-the-loop approvals, runs on your infra, one runner pool / route by tags, deploy
   anywhere (Docker/GHCR + compose, confidential VMs via dstack / Intel TDX).
6. **Final CTA** band → `/app` + `/docs`.
7. **Footer** — link row (hub, docs, llms.txt, GitHub) and the **back-compat footnote**: RunYard
   was formerly Smithers Hub, `SMITHERS_HUB_*` env vars are still honored, and it’s built on
   Smithers. Kept small, as requested.

### Links (all resolve to real routes — verified in `src/server.js`)
- Primary CTA → `/app` · Docs → `/docs` · `llms.txt` → `/llms.txt` ·
  GitHub → `https://github.com/yolo-maxi/runyard`.

## Eval gate results

Headless chromium (`/usr/bin/chromium` via `playwright-core`), script: `verify-landing.mjs`.
Serves `public/` locally so `/public/styles.css` resolves, loads the page at each width,
asserts `document.documentElement.scrollWidth <= window.innerWidth` and **no console/page
errors**, and screenshots each width.

| Width | scrollW | innerW | Overflow | Console errors | Screenshot |
|------:|--------:|-------:|:--------:|:--------------:|------------|
| 360   | 360     | 360    | none     | none           | `landing-shots/landing-mobile-360.png` |
| 390   | 390     | 390    | none     | none           | `landing-shots/landing-mobile-390.png` |
| 414   | 414     | 414    | none     | none           | `landing-shots/landing-mobile-414.png` |
| 768   | 768     | 768    | none     | none           | `landing-shots/landing-desktop-768.png` |
| 1280  | 1280    | 1280   | none     | none           | `landing-shots/landing-desktop-1280.png` |

**RESULT: ALL GREEN** — zero horizontal overflow and zero console errors at every width.

- **Backend suite:** `pnpm test` → **388 pass / 0 fail** (note: this worktree starts without
  `node_modules`; run `pnpm install` first, otherwise tests fail to import deps — that is
  environmental, not a regression).
- **`pnpm build:web`:** not required — `styles.css` was not touched.

Re-run the visual gate any time with: `node verify-landing.mjs`.

## Accessibility / responsiveness notes

- Semantic landmarks (`header`/`main`/`section`/`footer`/`nav` with `aria-label`s); the console
  card is `role="img"` with a descriptive label and its decorative `<pre>` is `aria-hidden`.
- Contrast uses brand tokens (ink/secondary on off-white; console fg on `--console-bg`).
- CTAs are real `<a>` elements, keyboard-focusable; focus-visible outlines come from the shared
  button system. Tap targets ≥44px on mobile.
- Motion is limited to one blinking console cursor, covered by the global
  `prefers-reduced-motion` rule in `styles.css`.

## Follow-up ideas (optional, not done)

- Consider promoting an OG/Twitter card image + `<meta property="og:*">` for link unfurls.
- A favicon is not served by the hub (`/favicon.ico` 404s in the browser) — harmless but worth
  adding a `<link rel="icon">` (could reuse the CSS brand-mark as an SVG favicon).
- The how-it-works flow could become an animated/SVG diagram later; current CSS version is
  intentionally restrained and overflow-safe.
