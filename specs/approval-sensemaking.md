# Approval Sensemaking

Date: 2026-07-04 · Branch: `runyard/approval-sensemaking` · Base: `main` @ 62bd4a4

Fran's observation: "So far I've never seen an approval that made sense." This report explains
why that is true, and proposes the smallest coherent fix. It builds on §5 of
`specs/product-surface-audit.md` (branch `runyard/product-surface-audit`) but goes one layer
deeper: the audit catalogued presentation defects; this pass found that the *model* itself asks
questions it cannot hear the answer to, and in the most common cases never asks at all.

Method: parallel targeted reads of the web approval views, Telegram notifier/callbacks,
MCP/API/CLI approval surfaces, the storage layer (`approvals` table, timers, holds), the
Smithers engine bridge, the supervisor escalation path, promotion, the `post-run-hooks` branch,
and every seeded workflow. All claims cite file:line on this branch; the two most load-bearing
claims (§2.1, §2.2) were re-verified by hand against source.

---

## 0. The one-paragraph diagnosis

RunYard approvals feel nonsensical because **the product never actually asks a question**. The
approvals a user was promised (run-start gates on dangerous workflows) are silently disabled by
an inert config flag. The one real in-workflow gate loses its author-written question in
transit and arrives as boilerplate. The supervisor asks a three-way question *after* it has
already failed the run, then discards the answer. The card copy describing consequences is
hardcoded for one approval kind and is false for the others. And the presentation layer guesses
card content from input key names because nothing upstream declares it. Every one of these is a
different way of violating the same contract: *an approval is a declared question with a
declared, executable consequence.* The fix is to make that contract first-class.

---

## 1. What approval is supposed to mean in RunYard

The specs are consistent about intent:

- The Hub's core promise includes making it obvious "what still needs a human decision"
  (`specs/product-intent-and-user-expectations.md:11`); "Humans supervise runs, artifacts, and
  approvals" (`:20`); Telegram is "an approval channel, not a separate workflow system" (`:146`).
- "Approvals are centralized Hub objects" resolvable from Web/API/CLI/MCP/Telegram
  (`specs/implementation-decisions.md:227-255`), with the deliberate decision that workflow
  *starts* do not block by default while dangerous actions do.
- The timer contract is explicit and good: "surface, don't decide" — an elapsed timer with no
  configured fallback never invents a decision and never fails the run
  (`src/approvalTimerRecords.js:8-12`, `src/dbSchema.js:162-166`).
- Approval-held runs are shielded from the reaper and never age out (PR #9, #10).

So the intended meaning is: **an approval is the Hub pausing one specific consequence until a
specific human answers a specific question, over whatever channel that human prefers, with the
run held safely (never failed) while the question is open.**

The product direction this report adopts as its bar: every approval must answer, on every
surface — **who** is being asked, **what** exactly will happen, **why** this needs a human,
**what happens if ignored**, **what options** exist, and **how to inspect/retry** after the
decision.

The recent model work (blocking holds, timed fallback, engine bridge) got the *safety*
semantics right. What's missing is the *question* semantics. That is why nothing "makes sense":
the machinery pauses correctly, but nobody can tell what they are being asked or what their
answer will do.

## 2. Why current approvals don't make sense

### 2.1 The advertised approvals never happen: `approvalPolicy.required` is inert

Every dangerous product seed declares an approval requirement with a human-written reason:
`implement-change-gated` — "Runs a coding agent that commits and pushes an isolated branch"
(`src/seedCapabilityProduct.js:43`); `idea-to-product` — "Runs coding agents and can deploy a
new static site" (`:81-84`); `workflow-doctor`, `improve`, `product-workflow`, `implement`,
`app-skinner`, `gobbler-comic-pipeline` likewise.

But the run-start gate never reads that flag. `approvalPolicyRequiresRunStartApproval`
(`src/runRecords.js:38-41`) returns true only for `runStartApproval`, `requireRunStartApproval`,
or `workflowStartApproval` — **and no seed sets any of them** (verified by grep across
`src/seedCapability*.js`, `src/seedCoreCatalog.js`). So no seeded capability produces a
run-start approval card today. The `required: true` reasons are consumed only as card
*description text* on a card that is never created (`src/runCreateStore.js:24,59,65`).

Worse, a leftover migration path actively erases any run-start approvals that do exist:
`autoQueueLegacyRunStartApprovals` (`src/operatorStore.js:286-303`) resolves them as
`system:auto-queue` with the comment "Workflow-start approvals no longer block runs by
default." An operator browsing history sees approvals that approved themselves.

**Net effect:** the catalog promises human gates on every dangerous workflow and delivers none.
This single fact explains most of "I've never seen an approval that made sense" — the approvals
Fran *has* seen are the weird residual kinds below, because the sensible kind is switched off.

### 2.2 The only real gate loses its question in transit

Exactly one workflow contains a real human pause: `app-skinner.tsx:122-138`'s `<Approval>` node,
whose author wrote a title ("Approve app skin direction"), a summary of the proposal, and
structured metadata (idea, skin count, recommendation, the skins themselves) — precisely the
context a decision needs.

The bridge throws all of it away. `smithers inspect` (0.22 shape) exposes only
`{nodeId, status, requestedAt}` per gate (`src/runnerEngineApprovals.js:41-55`), so the Hub card
is generic boilerplate: title `"Engine approval: app-skinner · skin:approval"`, a description
that names the `smithers approve|deny` CLI equivalent, and payload of ids
(`src/runnerEngineApprovals.js:60-87`). The one approval whose author answered the six
questions arrives answering none of them.

### 2.3 Escalations: the run is failed before the human is asked, and the answer is discarded

When autonomous recovery is exhausted, the supervisor first transitions the run to **`failed`**
(`src/runSupervisorStore.js:227`, current_step "escalated to operator") and *then* creates the
escalation card (`:238-241`). The card carries a genuinely well-designed three-way question —
`retry_anyway` / `edit_and_retry` / `abandon`, each with a label and an effect description
(`src/hubSupervisorRepair.js:50-54`).

But:

- **No surface renders the options.** Web shows Approve/Request changes/Reject; Telegram shows
  the same three fixed buttons (`src/telegramApprovals.js:83-100`); the options exist only
  inside the raw payload JSON block.
- **No handler exists for any option.** Grep finds `retry_anyway`/`edit_and_retry`/`abandon`
  only where they are written, never where they would be read. Resolution goes through the
  generic `resolveApproval` (`src/operatorStore.js:226-253`), which transitions a run only if it
  is `waiting_approval` — escalated runs are `failed`, so approving the card **does nothing to
  the run at all**.

The product asks its most important question — "autonomous recovery is exhausted, what should I
do?" — after the outcome is already decided, in a form no channel can express, and ignores the
reply. ~60 stale escalation cards observed in dogfood
(`docs/design/engine-approval-bridge.md:148-151`) are the direct consequence: cards that can't
do anything don't get resolved.

### 2.4 The card copy lies, because consequences are hardcoded for one kind

`approvalContext` (`src/approvalPresentation.js:160-167`) attaches consequence sentences to
*every* approval:

> `whatHappensIfApproved`: "The run will move from waiting_approval to queued, then a matching
> runner can execute it."
> `whatHappensIfRejected`: "The run will be cancelled and will not execute."

These are correct only for run-start approvals — the kind that no longer exists (§2.1). For an
engine gate, the run is already *running*; rejecting maps to `smithers deny` and the workflow
decides what happens (app-skinner continues by design, `onDeny="continue"`,
`app-skinner.tsx:136`). For an escalation, the run is already *failed* and no decision changes
anything (§2.3). The default `proposedAction` has the same disease: "Queue {workflow} for runner
execution…" (`:102-110`). So the detail view's "Decision outcomes" section — the one place that
tries to answer "what will happen" — is confidently wrong for every approval a user actually
encounters, and leaks the raw `waiting_approval` enum while doing it.

### 2.5 The question is guessed, not stated

Nothing requires an approval creator to say what is being approved, so the presentation layer
scavenges. `proposedChange` is the first input field whose *name* matches
`["workPrompt","idea","spec","change","changes","task","goal","prompt","description","summary","context","notes"]`
(`src/presentation.js:7`, used at `src/approvalPresentation.js:94-100`), truncated to 700 chars;
`proposedAction` similarly matches `["proposedAction","action","operation","command"]`. A
workflow input that happens to be called `command` becomes the card's headline action. This is
the "magical approval" anti-pattern: the card approves whatever string the heuristics fished
out, not a declared action.

### 2.6 Who is being asked: nobody in particular

- `requested_by` defaults to the string `"workflow"` (`src/dbSchema.js:172`).
- There is no audience, assignee, or delegation on a card. Any token holding `api`, `mcp`, or
  `admin` can resolve any approval (`src/serverRoutes.js:140-142`); the dedicated `approvals`
  scope grants nothing those don't (it matters only for Telegram-webapp sessions, which are the
  one place least-privilege is actually enforced — `src/telegramWebAppAuth.js:114-121`).
- The two read endpoints have **no scope gate at all** — any authenticated token can list every
  approval with full payload context (`src/serverRoutes.js:137-138`).
- Admin gating exists only as a per-capability authz check at trigger time
  (`src/capabilityRoutes.js:163-164`), unrelated to who may *approve*.

So "who is being asked" is unanswerable by design, and the admin-configures / policy-delegates
model the product wants does not exist in the approval layer.

### 2.7 The record of what was decided is dishonest

- `changes_requested` is stored as `status='rejected'` with the truth in a parallel `decision`
  column (`src/operatorRecords.js:102-131`); every consumer must re-derive it
  (`web/views/Approvals.jsx:16-22`).
- Engine auto-approvals mirror back as plain `approved` (`ApprovalAutoApproved → "approved"`,
  `src/runnerEngineApprovals.js:107-122`) — the audit trail cannot distinguish a human yes from
  a machine yes.
- A timer-applied fallback is visible only in the resolver string `system:approval-timer` and a
  comment; **no UI anywhere marks a run as auto-decided** — post-hoc, autopilot is invisible
  (word "autopilot" appears only in backend comments, `src/db.js:265`).
- Unknown decision strings silently become `rejected` (`src/operatorRecords.js:103`).
- No CHECK constraints exist on `approvals.status`, `decision`, `timer_state`, or `runs.status`
  (`src/dbSchema.js:113,167-184`); the enum is whatever JS module you ask.

### 2.8 Waiting is invisible, mislabeled, or buried

- A run paused for approval renders as **"Running"** in the progress strip — `waiting_approval`
  maps to `running="active"` (`web/lib/runHelpers.js:150-166`); the "waiting on a human" phase
  does not exist in the run's own progress UI.
- Approvals have no sidebar entry; the only path is a topbar bell showing a dot with no count
  (`web/app/Shell.jsx:59-76,167-172`). The Home view's pending-approvals strip exists only in
  dead code (`web/components/HomeChrome.jsx:108`, zero imports).
- The list card offers two actions (Approve/Reject) while the detail offers three; the list
  strips requester, consequences, timer, and renders the run id as plain unlinked text
  (`web/components/ApprovalList.jsx:22-45`). Deciding from the list means deciding blind.
- Timers: the deadline is never shown on the card, the bell, or the run page; only the detail
  view shows it, as a raw ISO string (`web/views/Approvals.jsx:151-156`). The run-page
  diagnostics approval summary omits timer fields entirely (`src/runDiagnostics.js:84-95`).
- The run page itself has no approve/reject affordance — an operator looking at the paused run
  must find the diagnostics panel's "Linked approval" link.

### 2.9 Telegram: same generic card for every kind, silent about time, mute after deciding

- One template for all kinds (`src/telegramApprovals.js:39-76`), with a vestigial empty section
  header — `<b>Thing being approved</b>` immediately followed by `<b>Proposed change</b>` with
  nothing between (`:53-54`).
- **No timer, no fallback, no consequences**: a Telegram approver of a timed approval cannot
  tell that doing nothing will auto-decide; none of `timeoutAt`/`timerState`/`fallback` or the
  `whatHappensIf*` strings are rendered.
- Escalation options are not rendered (three fixed buttons only, §2.3).
- After a decision the buttons are cleared and a toast shown, but the message body still ends
  with "Use the buttons below to decide." — no edit records who decided or what happened
  (`src/approvalHttpRoutes.js:156-169`, `src/telegramBotClient.js:61-73`). No re-notification
  when a timer elapses (`notifyTelegram` fires only at creation).

### 2.10 Vocabulary collisions manufacture confusion

- `blocked_by_gate` is a *test/build hard-failure* class (`"GATE FAILED: pnpm test did not
  pass."`, `implement-change-gated.tsx:307`; matched by `src/runFailureClass.js:16`) — no human
  is asked anything — yet it shares the word "gate" with engine approval gates and sits next to
  `needs_human` (a regex over error prose, `src/runFailureClass.js:21`) and `waiting_approval`
  in the same status column. Four vocabularies for "a human is involved," two of which involve
  no human.
- MCP tools `approve_run`/`reject_run`/`request_changes_run` take an `approvalId`
  (`src/mcp.js:40-42`); CLI says `approve`/`reject`/`request-changes`; HTTP says
  `request-changes`; storage says `changes_requested`; Telegram callbacks accept five aliases
  (`src/telegramApprovals.js:140`); the engine has only `approve|deny`.
- CLI `runyard approvals` can only ever list pending (hardcoded, `src/cli.js:328-331`) though
  the endpoint takes any `?status=`.

### 2.11 Side effects: the approval story and the hooks story haven't met

`origin/runyard/post-run-hooks` (e029b31) correctly makes side effects admin-registered, named
hook profiles with default-closed eligibility, and correctly keeps merge-to-main behind
explicit promotion. But it models "approval" purely as *admin authorship + capability opt-in* —
**there is no per-profile "requires human approval" flag and no `side_effect` approval card**
(`docs/design/post-run-hooks.md` on that branch; `src/hookProfileRecords.js:170`). Meanwhile
promotion — the flagship human decision — has no approval object either; the API call is the
approval (`src/runPromotionRoutes.js:18-42`). Result: the product's most consequential
human-in-the-loop moments (publish, push, promote) never appear in the approval inbox at all,
while the inbox fills with escalation cards that do nothing.

## 3. The unified approval object RunYard should expose

One table (the existing one — this is additive), one honest lifecycle, and a first-class **ask
contract** that creators must supply and surfaces merely render. No more scavenging.

```
approval {
  id, run_id

  kind:        workflow_gate | escalation | side_effect | custom
               -- stored column, not payload archaeology. Backfill from payload.kind.
               -- workflow_gate absorbs engine_approval, checkpoint, child_run_approval.
               -- run_start is retired (see §6); legacy rows backfill as kind=custom.

  status:      pending | resolved            -- the only two states
  resolution:  approved | rejected | changes_requested | option:<id> | superseded
               -- superseded = run reached terminal state while card was pending
  resolved_via: human | fallback_timer | engine | policy | system
  resolved_by: actor string (existing)

  ask: {                                     -- REQUIRED at creation, stored, rendered verbatim
    audience:   admins | operators | delegated(<policy-name>)
    action:     one declared sentence: what exactly happens on approve
                ("Publish the generated site to repo.box:/srv/site, replacing the live copy")
    reason:     why a human is needed
                ("This hook leaves the run sandbox" / "Autonomous recovery exhausted after 3
                 identical failures")
    if_ignored: blocks (waits forever, run held)
                | falls_back { at: <ts>, applies: <decision> }
    options:    [{ id, label, effect }]      -- offered ONLY if a registered handler exists
  }

  timer: timeout_at, fallback, timer_state, timer_elapsed_at   -- unchanged (PR #10 is right)
}
```

Rules that make this coherent:

1. **Creation requires the ask.** `POST /api/approvals` rejects (or flags as `ask_incomplete`)
   cards without `action` + `reason`. Every internal creator — engine bridge, supervisor,
   run-smithers checkpoints, future hooks — supplies its ask explicitly. The input-key
   heuristics (`src/presentation.js:5-9`) survive only as a fallback for `custom` cards and are
   marked as derived in the payload.
2. **Consequences are computed per kind from the actual transition table**, never hardcoded
   prose. A `workflow_gate` card says "the workflow resumes past this gate / the workflow takes
   its deny path"; an `escalation` card describes the selected option's effect; a `side_effect`
   card says "the hook runs / the hook is skipped, the run's work is unaffected."
3. **Options are executable or absent.** Offering an option means a handler is registered for
   `option:<id>` resolution. Escalation handlers: `retry_anyway` → supervisor requeue-from-
   checkpoint; `abandon` → finalize + suppress further cards; `edit_and_retry` → link to
   edit-and-rerun prefilled with the run's input.
4. **Machine decisions are named.** `resolved_via` distinguishes a human yes from timer
   autopilot from an engine-side CLI decision from policy auto-approval. `status` stops lying:
   `changes_requested` is a resolution, not a flavor of `rejected`.
5. **Terminal-run hygiene is built in.** When a run reaches a terminal state, its pending cards
   resolve as `superseded` (`resolved_via: system`) in the same sweep that handles timers. The
   inbox can then be trusted.
6. **Audience is enforced where it can be, displayed where it can't.** `audience: admins`
   requires admin scope to resolve; `delegated` names the policy that granted resolution rights.
   Configuring approval policies (which hooks/gates require approval, fallbacks, delegation) is
   admin-only; *resolving* follows the card's audience. The read endpoints gain a scope gate.

## 4. UX rules for approval cards across surfaces

**The invariant on every surface:** a card renders the six answers — who / what / why /
if-ignored / options / what-next — from the stored ask. Never derived, never kind-agnostic
boilerplate, never raw enums.

**Web**
- Approvals becomes a primary sidebar item with a visible pending count (the bell can stay as a
  shortcut). Revive the Home pending-approvals strip (the dead `HomeChrome` tile proves the
  intent existed).
- The list card and detail view offer the **same decision set** and the same minimum context:
  action sentence, reason, requester/audience, deadline ("Decides itself in 3h → approve" as a
  relative countdown, not raw ISO), and a *linked* run.
- The run detail page shows a "Waiting on a human" banner with inline resolve actions when a
  card is pending; the progress strip gets a distinct "Waiting for approval" phase (a paused run
  must never render as "Running").
- After a fallback fires, the approval and the run timeline both show an explicit "Decided by
  timer (autopilot): approved" marker.

**Telegram**
- Per-kind first line ("Workflow paused for your sign-off" / "A run needs a recovery decision" /
  "A run wants to publish outside its sandbox").
- Timed cards always state the deadline and fallback: "If nobody decides by 18:00, this will be
  approved automatically." Blocking cards say "This run waits until someone decides."
- Options render as buttons when present (callback `approval:option:<id>:<approvalId>`).
- After resolution, edit the message body to "✅ Approved by @fran at 17:42" — never leave "Use
  the buttons below to decide." on a decided card. Remove the vestigial empty header.

**MCP**
- `list_pending_approvals` returns the ask fields, and each tool description says it takes an
  approval id. Add `resolve_approval(approvalId, decision, option?, comment?)`; keep the
  `*_run` names as deprecated aliases for one release. Responses return the card summary
  (id, kind, action, resolution, run link) — not a raw pretty-printed HTTP dump.

**API**
- `GET /api/approvals` accepts `status`/`kind` filters, requires a scope, and returns the ask.
  Decision endpoints gain `POST /api/approvals/:id/resolve {decision|option, comment}` as the
  canonical verb; existing verb routes remain as aliases.

**CLI**
- `runyard approvals [--status any|pending|resolved] [--kind …]` renders a table of
  kind · action · deadline · run. `runyard approve|reject|request-changes <id>` stay;
  `runyard approve <id> --option retry_anyway` covers options. Resolution output is one
  sentence ("Approved. Run r_123 resumed past gate skin:approval — runyard runs r_123"), not
  the full JSON object.

## 5. Status and failure semantics around approvals

**Before (pending, blocking):** run status `waiting_approval` presented as "Waiting for
approval" (humanized everywhere; raw enum only in JSON). For gates that pause a *running*
engine workflow, the run stays `running` but every surface that shows the run shows the pending
card ("Paused at gate: Approve app skin direction"). Held runs are never reaped or deadlined
(already true — keep).

**Before (pending, timed):** same, plus the deadline and the configured fallback visible on
run, card, bell tooltip, and Telegram. "Ignoring this" has a stated meaning.

**During resolution:** resolving performs exactly what the card's consequence text said,
because both come from the same per-kind table. CAS prevents double-resolution (already true).

**After a human decision:**
- Approved workflow_gate → run continues; timeline event "Gate approved by fran".
- Rejected/changes_requested run-blocking card → run becomes `cancelled` with the card's
  comment as the visible reason — **cancelled, not failed**: a human saying "no" is a decision,
  not a malfunction, and must not pollute failure analytics.
- Escalation option → the option's handler runs; timeline shows "Operator chose: Resume once
  more". The run leaves `failed` via the existing supervisor requeue path.

**After timed fallback:** the card resolves via `fallback_timer`, the run proceeds per the
decision, and both run and card visibly say the decision was automatic. A timer that elapses
with no fallback keeps the card pending, badges it "needs a decision now", re-notifies
(Telegram + operator alert), and never fails the run (already true at the model layer — keep,
surface it).

**Approval failure never flattens into run failure.** The only statuses an approval can push a
run to are `queued`/`running` (approved) and `cancelled` (declined). `needs_human` as a
failure-*class* should mean exactly one thing: a run ended because a pending human decision was
required and the workflow could not hold (rare); it must not be a regex over error prose. An
escalated run should read "Needs a decision" (held, card pending) rather than pre-emptively
`failed` — if the model keeps `failed` for supervisor accounting, the *presentation* must lead
with the pending decision, and resolution must actually act (§3 rule 3).

**Side effects:** hook outcomes (`hook_failed`, `hook_config_required`, `hook_blocked`) stay
run-status-neutral as the hooks branch already does; a `side_effect` approval only ever gates
the hook, never the green run behind it.

## 6. Merge, rename, hide, remove

**Merge**
- `engine_approval` + `checkpoint` + `child_run_approval` payload conventions → `kind:
  workflow_gate` (one column, one presentation).
- The three-field truth (`status`/`decision`/`timer_state`) → `status` + `resolution` +
  `resolved_via` (§3).
- Duplicate decision vocabularies → one canonical set: `approved`, `rejected`,
  `changes_requested`, `option:<id>`, `superseded`.

**Rename**
- MCP `approve_run`/`reject_run`/`request_changes_run` → `resolve_approval` (+ aliases one
  release).
- Card titles: "Engine approval: {slug} · {node}" → the gate's own request title.
- "Supervisor escalation: {slug}" → "Needs a decision: {slug} — {reason sentence}".
- User-facing copy: "approval" (a card a human resolves) and "gate" (a place a workflow can
  pause) only; hold/escalation/checkpoint become internal words, per the audit's glossary rule.
- `waiting_approval` and friends humanized everywhere a human reads them.

**Hide**
- Raw payload JSON on the detail page moves behind a collapsible "Details (JSON)".
- `smithers approve --iteration N` remediation text stays in runner/ops docs, not on cards.
- Engine-CLI mirroring (`resolved_via: engine`) renders as "Decided on the runner", not
  `engine:cli`.

**Remove**
- The inert `approvalPolicy.required` ambiguity: either wire it to run-start gating or rename it
  to what it is (documentation + Telegram-notify hint). Do not ship a config flag named
  `required` that requires nothing. Recommendation: retire run-start gating entirely (the
  auto-queue path already declared its death) and re-point the seeds' `reason` strings at the
  gates that actually exist (engine gates, promote, hooks).
- `autoQueueLegacyRunStartApprovals` once existing rows are migrated — approvals that approve
  themselves must not be a standing behavior.
- Telegram dead callback aliases (`changes`, `changes_requested`, the 2-part legacy format) and
  the vestigial empty `<b>Thing being approved</b>` header.
- `web/components/HomeChrome.jsx` (or revive deliberately as the Home approvals strip).
- The unreachable-by-buttons escalation `options` array **until** handlers exist (§3 rule 3) —
  shipping a question whose answers are ignored is worse than not asking.
- The `needs_human` error-prose regex (`src/runFailureClass.js:21`) once escalation semantics
  land.

## 7. Prioritized implementation plan (small branches)

Ordered so each branch is independently shippable and the model lands before the paint.

1. **`runyard/approval-kind-resolution`** (small, model): add `kind`, `resolution`,
   `resolved_via` columns + CHECK constraints; backfill from payloads; stop collapsing
   `changes_requested` into `status='rejected'`; terminal-run sweeper resolving pending cards as
   `superseded` (kills the ~60 stale-card problem); auto-queue path retired after backfill.
   Everything else builds on this.
2. **`runyard/approval-ask-contract`** (medium, model+API): `ask` block on create (audience,
   action, reason, if_ignored, options); per-kind consequence table replacing the hardcoded
   `whatHappensIf*` strings; supervisor and run-smithers creators supply their asks; engine
   bridge propagates the `<Approval>` request title/summary where the engine exposes it (0.22
   inspect doesn't — carry it via the run state file or note the ≥0.25 upgrade), otherwise a
   per-workflow ask registered at seed time; heuristic derivation demoted to `custom`-kind
   fallback.
3. **`runyard/escalation-options-act`** (medium, behavior): handlers for
   `retry_anyway`/`abandon`/`edit_and_retry` wired to the existing supervisor requeue/finalize
   paths; escalated-run presentation leads with the pending decision; options rendered as
   buttons on web + Telegram. This is the branch that makes the supervisor story real.
4. **`runyard/approval-surface-parity`** (small/medium, web): sidebar entry + count; list card =
   detail (same three actions, action/reason/deadline/linked run); "Waiting for approval" phase
   in the progress strip; approve/reject on the run page; autopilot/superseded badges;
   humanized labels via one shared map.
5. **`runyard/telegram-approval-context`** (small): per-kind lead line; deadline + fallback
   sentence on timed cards; post-decision message edit; option buttons; header cleanup;
   re-notify on `fallback_required`.
6. **`runyard/approval-verb-parity`** (small): MCP `resolve_approval` + honest descriptions;
   CLI/MCP status+kind filters; `POST /api/approvals/:id/resolve`; scope gate on reads; make
   `approvals` a real least-privilege scope (mintable, and the only non-admin scope decision
   endpoints accept for `audience: operators` cards).
7. **`runyard/side-effect-approvals`** (rides `post-run-hooks`): per-profile
   `requiresApproval: true` creating a `side_effect` card (ask: hook name, target, secrets by
   name) before the hook executes; promote optionally gated the same way for non-admin callers.
   Only hooks whose profile demands approval create cards — ticking a boolean never does.

The audit's `runyard/approval-resolution-model` suggestion is superseded by 1+2; its Telegram
and stale-card items land in 5 and 1 respectively.

## 8. Acceptance criteria and tests for "approval makes sense"

An approval makes sense when a person who has never seen RunYard can read one card and answer
all six questions. Concretely:

**Model invariants (unit tests)**
- Every created approval has non-empty `kind`, `ask.action`, `ask.reason`; creation without
  them fails or flags `ask_incomplete` (extend `tests/approval-routes.test.js`).
- `resolution` round-trips: request-changes stores and lists as `changes_requested`; a timer
  fallback stores `resolved_via='fallback_timer'`; an engine auto-approve stores
  `resolved_via='engine'`; no path writes a resolution outside the CHECK constraint.
- Resolving a card on a terminal run is rejected as `superseded`; the sweeper resolves pending
  cards within one maintenance tick of run termination (extend `tests/approval-timer.test.js`
  sweep suite).
- Resolving an escalation with `option:retry_anyway` requeues the run from its checkpoint
  (assert run status + lineage row); `option:abandon` finalizes and creates no further cards
  (extend `tests/hub-supervisor-repair.test.js`).

**Consequence honesty (unit tests)**
- For each kind, the consequence text asserted against the actual transition performed:
  approving an engine-gate card must never claim the run will move from `waiting_approval` to
  `queued`; rejecting a run-blocking card yields run `cancelled` (never `failed`) with the
  comment as the visible reason (extend `tests/approval-presentation.test.js`).

**Surface parity (unit/integration tests)**
- Web list card and detail expose identical decision sets and both render action, reason,
  deadline, and a linked run (component render test).
- Telegram text for a timed card contains the deadline and the fallback decision; after a
  callback decision the message body is edited to name the actor and outcome (extend
  `tests/telegram-approvals.test.js`).
- MCP `list_pending_approvals` items each contain `kind`, `ask.action`, `ask.reason`,
  `deadline`, `deepLink`; `resolve_approval` exists and the `*_run` aliases warn.
- CLI `runyard approvals --status resolved` returns history.

**Enum hygiene (lint-style test)**
- A test greps rendered strings (web components, Telegram templates, card copy builders) for
  `waiting_approval`, `changes_requested`, `blocked_by_gate`, `fallback_required` and fails on
  new leaks — the same enforcement pattern the audit proposes for naming.

**End-to-end "the story testers will try"**
- Start an app-skinner run from MCP → the card arrives titled with the gate's own question and
  carries the skin summary → approve from Telegram → the Telegram message edits to "Approved by
  …" → the run resumes and the timeline reads "Gate approved" → `runyard approvals --status
  resolved` shows `resolution=approved`, `resolved_via=human`.
- Kill a run into escalation → run presents "Needs a decision", not a bare failure → choose
  "Resume once more" from the web card → run requeues → lineage shows the operator action.
- Create a timed approval with fallback → ignore it → run proceeds; card, run timeline, and
  approval history all say the timer decided.

When those three walk-throughs read sensibly on every channel, the original complaint is
falsifiable — and fixed.

---

*Compiled from five parallel surface investigations (web, Telegram, MCP/API/CLI, storage/model,
engine+workflows+supervisor) plus hand verification of the inert run-start flag
(`src/runRecords.js:38-41`) and the auto-queue path (`src/operatorStore.js:286-303`). No product
code was changed on this branch.*
