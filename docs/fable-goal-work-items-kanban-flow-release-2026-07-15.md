# Goal: Work Items, Kanban, and Workflow Flow Legibility for RunYard

Date: 2026-07-15
Repo: /home/xiko/runyard
Runner: Claude Fable (`claude --model claude-fable-5 --dangerously-skip-permissions`)

## User Context

Fran wants RunYard to become the default company-wide software factory. The current product is too execution-centric: it shows workflows, runs, approvals, events, and artifacts, but it does not expose the durable unit of work a company thinks in.

Implement the product slice as you see fit, but preserve the core model:

- **Ticket / Work Item**: the durable company work object, e.g. "Make pause/resume fully supported".
- **Workflow**: the reusable process definition/recipe.
- **Run**: one execution attempt of a workflow.
- **Kanban**: ticket lifecycle view.
- **Flowchart**: workflow/run execution view attached to a ticket.

Tickets are not workflows, and runs are not tickets. A ticket can use one workflow, many workflows, or no workflow yet. A failed run should not make the ticket "failed"; the ticket should move to a human-legible state like blocked, review, waiting, or retrying.

## Product Bar

Ship a first useful version that makes RunYard feel like a software factory OS, not just an agent runner dashboard:

1. A top-level Work/Factory surface where humans can see what is being shipped.
2. First-class work items/tickets with durable state.
3. Workflow runs can attach to a work item.
4. The board answers: what is where, who owns next action, what is blocked, what is ready for review, and what shipped?
5. The ticket detail answers: what are we trying to do, what runs/approvals/artifacts are attached, what happened, and what is next?
6. A flow/graph view answers: where is this ticket in its workflow/run, which steps are done, waiting, failed, or active?
7. API/MCP/CLI surfaces exist enough that agents can create/list/update work items and link runs.
8. Existing run/workflow behavior remains compatible.

Prefer a small, real product slice over a giant project-management clone.

## Suggested Lifecycle

Implement a pragmatic lifecycle. Names can change if the codebase has a better local convention, but preserve the meaning:

- `intake`: raw ask / idea / bug / product need.
- `triaged`: priority, type, owner, and acceptance criteria clarified.
- `ready`: next workflow/action selected and dependencies known.
- `running`: one or more workflow runs actively working on it.
- `waiting`: paused for approval, human decision, external credential, budget, or dependency.
- `blocked`: cannot progress without a specific intervention.
- `review`: deliverable exists and needs inspection.
- `shipped`: merged/released/deployed with evidence.
- `accepted`: confirmed to satisfy the original ask.
- `archived`: closed historical item.

The board can group these into fewer lanes if that is clearer.

## Data Model

Add a durable work item table/model with fields like:

- id
- title
- description / goal
- project
- type (`feature`, `bug`, `research`, `release`, `maintenance`, etc.)
- status / lane
- priority
- owner / requester
- acceptance criteria
- next action
- blocked reason
- created/updated timestamps
- optional due/target metadata

Add a run -> work item association. If the existing schema style prefers a join table over a nullable `work_item_id` column, use that. It should support many runs per work item and allow old runs to remain unlinked.

Optionally add work item events/history if the existing run event system can be reused cleanly.

## UI

Add a real product surface, likely a new top-level `Work` or `Factory` nav item.

Minimum useful UI:

- board/kanban view of work items by lifecycle lane;
- create/edit controls for a work item;
- work item detail with title, status, priority, owner, acceptance criteria, next action, blocked reason;
- linked runs with status, latest event, artifacts/approval links;
- flow/graph/step view generated from the linked active/latest run where possible;
- affordance to launch or link a workflow run from a work item if the existing launch UI makes this feasible in scope.

Keep it dense and operational, not a landing page. This is a software factory cockpit.

## API / MCP / CLI

Add enough surface for agents and scripts:

- list work items with filters by status/project/owner/type;
- create/update work item;
- link/unlink run to work item;
- include work item info on run read payloads if linked;
- MCP tools for basic work item operations;
- CLI commands for list/create/update/link if straightforward.

Update OpenAPI/discovery docs and tests so drift is caught.

## Flowchart Semantics

Do not build a fragile hand-drawn project chart.

Generate flow from existing workflow/run state:

- completed steps;
- active/current step;
- waiting approval / paused / blocked steps;
- failed step and retry/recovery path if known;
- links to artifacts/approvals/events.

If the existing event model cannot reliably reconstruct a full graph, ship a simple "execution flow" timeline/stepper first and document the next graph hardening step.

## Non-Goals

- Do not replace all existing run pages.
- Do not build a full Jira clone.
- Do not break existing APIs, run creation, releases, approvals, pause/resume, or docs.
- Do not make the UI decorative. Prioritize legibility and operational density.
- Do not run builds/tests on repo.box. Build/test on Hetzner only.

## Gates

Keep fixing until clean:

- `git diff --check`
- targeted DB/model tests for work items and run links
- targeted API route tests
- targeted MCP/CLI/parity tests
- targeted web render/smoke tests for board/detail/flow
- `pnpm test`
- `pnpm build`
- `pnpm build:docs` if docs/discovery pages change
- `node --check` for touched JS entrypoints where useful
- local/scratch smoke: create a work item, link a run, move it across states, verify board/detail/flow render

## Release / Deploy

If scoped and clean:

- commit feature changes;
- cut the next semver release after `v0.9.0`;
- push `main` and tag;
- let CI build/release;
- deploy/restart live RunYard using existing conventions;
- verify live:
  - `/api/version`
  - `/readyz`
  - `/app`
  - relevant Work/Factory routes/assets
  - OpenAPI/docs/discovery
  - a safe scratch work item + linked run if practical

## Report Back

Report:

- whether the first work-item/kanban/flow slice shipped;
- release/tag/commit;
- exact data model and lifecycle;
- API/MCP/CLI/UI/docs added;
- verification evidence;
- what remains for a more advanced graph/board later.
