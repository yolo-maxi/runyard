# Fable Goal: Make the RunYard Work Board Gorgeous

Date: 2026-07-15
Repo: `/home/xiko/runyard`
Live product: `https://runyard.repo.box`
Current live baseline: `v0.10.3`

Fran's direct feedback after the first Work board pass:

> "so make it gorgeous. Get Fable and bully it to make something that looks like a Silicon valley product"

Take this literally. The existing Work board is now functional, but the bar for this pass is a polished operator surface that feels like a serious Silicon Valley product. Think Linear, Vercel, Modal, Retool, GitHub Projects, and modern infra dashboards: dense, calm, elegant, legible, fast, purposeful.

## Mission

Redesign and ship the RunYard Work board and linked work item detail experience so it looks and behaves like a polished product surface, not a bolted-on kanban.

Important clarification from Fran at 2026-07-15 16:35 UTC:

The board cannot read as a separate product. It must be built into RunYard workflows. RunYard should feel like a workflow-enhanced software factory where kanban is the operating surface for the work being executed by workflows/runs.

This means the pass is no longer only visual polish. Treat this as a product integration pass:

- design one concrete Kanban/Work board instance specifically for RunYard's own work
- make it possible to have multiple board instances later
- populate the RunYard board with meaningful software-factory tickets you choose
- configure the RunYard board so it is useful immediately on live prod
- connect workflow launching/linking/updating so boards do not feel manually detached
- make workflow/run state update cards where a reliable mapping exists
- make it obvious from the UI how to trigger or continue a workflow from a ticket
- preserve the gorgeous/polished product bar

The final result should make it immediately obvious:

- what needs Fran's attention now
- what is actively running
- what is blocked or waiting on a decision
- what is ready to launch
- what was shipped or accepted
- how a work item relates to runs, approvals, artifacts, and workflow progress

Do not remove the work item model or API surface. This is a product/UI quality pass on top of the existing feature.

## Design Standard

This must be more than "make the cards nicer."

Build toward:

- strong visual hierarchy
- high-quality typography and spacing
- restrained color with meaningful accents
- crisp lane/card/action states
- clear empty states
- a useful operator command area
- elegant status chips and metadata
- polished focus/hover/active states
- mobile/tablet layouts that are usable, not afterthoughts
- no text overflow, no clipped buttons, no mystery controls
- no huge marketing hero, no decorative gradient blob soup, no card-inside-card mess

The RunYard app is an operational tool. It should be quiet, dense, sophisticated, and scannable. Prefer a refined product dashboard over a flashy landing page.

## Product Shape

Keep or improve these core concepts:

- "What needs action" as the operator queue / command surface
- board summary counters
- lanes in operator language
- card action labels
- ticket detail with linked runs, approvals, artifacts, and execution flow
- workflow launch and continuation affordances attached to tickets
- run/workflow events feeding back into ticket/board state
- one configured RunYard software-factory board instance

Improve the actual UX:

- The top action area should feel like a command center, not a banner.
- Cards should communicate priority, state, next action, owner/project, linked run health, and age without becoming noisy.
- Lanes should have clear headers, counts, and hints, but should not feel like seven identical boxes.
- The selected/open ticket detail should feel like a proper inspector/workbench.
- The execution flow should read as progress, not raw logs.
- If there are few work items, the page should still look intentionally populated and useful.

## Workflow-Enhanced Factory Requirements

Model the first "board instance" in the smallest durable way that fits the current codebase. Do not overbuild a complete enterprise Jira clone, but do make the architecture clearly capable of multiple boards.

Minimum viable shape:

- a durable board/config concept, even if lightweight:
  - id/slug/title/project or scope
  - lane definitions/order
  - filters or membership rules
  - default workflow launch affordances
- a seeded/configured RunYard board instance for RunYard's own development work
- meaningful live work items on that board, not demo filler
- work item creation/linking from workflow launch where appropriate
- ability to launch an appropriate workflow from a ticket
- ticket detail shows linked runs and a clear "continue/run workflow" control
- board/lane state derives from linked run/approval state where reliable:
  - running linked run -> In motion
  - waiting approval -> Needs decision
  - failed/cancelled run -> Blocked or Review depending on context
  - completed implementation run -> Review / approve or Done when accepted
- explicit event/history entries when a workflow/run moves a ticket
- API/CLI/MCP/docs should reflect the built-in workflow-backed board concept at least enough that it is not web-only magic

Populate the RunYard board with real useful tickets. Suggested tickets you may include or adapt:

- Make Work board visually production-grade
- Wire Work board to workflow launch/update lifecycle
- Add board instances and RunYard default board
- Improve workflow retry/repair operator UX
- Design run cost/usage budget review queue
- Polish approval inbox and decision context
- Document RunYard software-factory operating model
- Add board templates for product, infra, docs, and release trains

Use judgment. The point is that Fran should open `/app#work` and see a real factory board for RunYard, not an empty shell or random scratch item.

## Implementation Guidance

Read the existing app structure first. Likely relevant files include:

- `web/app/*`
- `public/app.js`
- `public/styles.css`
- `tests/work-ui.test.js`
- work item API/store/tests under `src/workItem*` and `tests/work-item-*`

Use existing framework and local patterns. Do not rewrite the app from scratch. Do not introduce a large new UI framework unless it is already present and clearly appropriate.

If you need icons, use the repo's existing icon approach or lightweight inline symbols consistent with the app. Do not add random decorative imagery.

Use a design pass before coding:

1. Inspect current `/app#work` visually with browser screenshots at desktop and mobile.
2. Identify the top visual/UX failures.
3. Implement the redesigned Work board/detail surface.
4. Re-check visually with screenshots and automated assertions.
5. Iterate until it actually looks polished.

## Required Verification Gates

Loop until clean or document a real blocker:

- `git diff --check`
- `node --check` on touched plain JS files where applicable
- targeted Work UI/render tests, especially `tests/work-ui.test.js`
- targeted board/workflow integration tests for seeded board config, workflow launch/linking, and run-state-derived ticket movement
- full `pnpm test`
- `pnpm build`
- browser smoke against local or live app for `/app#work`:
  - desktop screenshot
  - mobile screenshot
  - Work nav visible
  - operator queue visible
  - board lanes visible
  - at least one card visible or an intentional high-quality empty state
  - no horizontal overflow
  - no clipped card text or clipped buttons
  - detail/inspector view opens and remains readable

If browser automation is available, use it. If not, use the repo's existing screenshot/test tools.

## Release / Deployment

If the gates pass, cut a release and deploy it live. This should probably be `v0.10.4` unless you judge the scope deserves `v0.11.0`.

Given the workflow-backed board requirement, `v0.11.0` is reasonable if the data/API surface changes meaningfully.

After deploy, verify:

- `https://runyard.repo.box/api/version`
- `https://runyard.repo.box/readyz`
- `https://runyard.repo.box/app`
- `https://runyard.repo.box/app#work` via browser smoke
- GitHub CI / image build status if a tag is pushed

Leave the repo clean unless there is a documented blocker.

## Reporting

When complete, report:

- version/tag deployed
- commits
- exact gates passed
- live verification results
- screenshot paths
- any remaining visual/product compromises

If you think the current data model prevents a truly good UX, say so explicitly and make the smallest necessary data/product fix. But do not use that as an excuse to ship another mediocre board.
