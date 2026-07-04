# Runyard Product Surface Audit

Date: 2026-07-04 · Branch: `runyard/product-surface-audit` · Base: `main` @ 62bd4a4

This is an opinionated audit of everything a user, agent, or operator can currently see or touch:
the public site and discovery docs, the authenticated web app, the capability catalog and input
schemas, the approval model, the run status model and failure taxonomy, MCP/CLI/API parity, and the
runner/admin setup surfaces. It exists because the "deploy vs hook" discussion exposed a pattern:
Runyard has been making product-shape decisions one workflow at a time, and the seams show.

Related in-flight branches this audit is written to inform, not duplicate:

- `runyard/sexy-public-site` — public landing/docs redesign. Section 2 is its requirements list.
- `runyard/post-run-hooks` — admin-gated post-run hooks. Section 4 argues this is the right shape
  and says what it must absorb.

Method: targeted reads of `public/`, `web/`, `src/`, `src/seed*`, `workflow-templates/`, `specs/`,
`docs/design/`, `bin/`, and `install.sh`, cross-checked against tests and the discovery docs.
File references are cited inline. No product changes are made on this branch.

---

## The five decisions that matter most

1. **Give the catalog an audience model.** All 17 seeded capabilities — real products, dogfood
   tooling, and infrastructure — render as one flat list on every surface. There is no visibility
   field at all; "Internal" is just a category string. Decide the tiers (product / operations /
   internal) and make every surface respect them.
2. **Make side effects a product concept.** "Deploy" today is a per-workflow boolean whose meaning
   is defined by each workflow's code plus runner env vars (`GATED_PROD_*`, `REPOBOX_*`,
   `STATIC_ROOT`). Promote is API-only. Response endpoints are unreachable from CLI/MCP. The
   `post-run-hooks` direction is right: one admin-registered, named, approval-visible mechanism
   for everything that leaves the run sandbox.
3. **Unify "wait for a human" into one honest approval object.** Five approval kinds exist only as
   implicit payload conventions; the stored status enum can't represent `changes_requested`;
   escalation options are rendered nowhere; a run needing a human can be `waiting_approval`, or
   `blocked_by_gate`, or `needs_human`, or just holding a card — four vocabularies for one concept.
4. **Draw the trust boundary and enforce it.** Unauthenticated `/llms.txt` publishes the live
   capability catalog and the bootstrap-token file path; unauthenticated `/api/setup` returns the
   server hostname and data directory; the web app shows the Admin menu to everyone and lets any
   token holder request `admin` scope; CLI and server disagree about default token scopes.
5. **Finish the language migration.** RunYard vs Runyard vs runyard vs Smithers Hub, `SMITHERS_*`
   env vars in user-facing docs, `shub_session` cookie, raw enums (`waiting_approval`,
   `superseded`) as visible UI labels, "capability" and "workflow" used interchangeably and
   inconsistently, and internal jargon (obstruction, lineage, fingerprint, wrapper) leaking into
   copy.

Everything below expands these, plus the smaller findings, by decision area.

---

## 1. Naming and language

### 1.1 The product has four names

- **What feels wrong:** `public/landing.html` says "RunYard" in its title, prose, and footer while
  its own brand element renders lowercase "runyard"; `docs.html`, `README.md`, and
  `discoveryDocs.js` say "Runyard"; the specs and tests still say "Smithers Hub"; the session
  cookie is `shub_session` (`src/authRoutes.js:58`); runner env vars are `SMITHERS_RUNNER_*` and
  `SMITHERS_WORKSPACE` in the public docs. The founder brief is titled "RunYard Architecture
  Brief".
- **Why it matters:** the very first thing a prospective self-hoster sees is a product that can't
  spell its own name consistently. Every doubled name also doubles search/grep cost for
  contributors and confuses agents reading `llms.txt`.
- **Recommended shape:** one written form — **Runyard** (the spec already mandates it,
  `specs/product-intent-and-user-expectations.md:5`) — enforced by a lint/test over `public/`,
  `web/`, and `specs/`. "Smithers Hub" survives only in back-compat code comments and env-var
  fallback logic, never in rendered copy. Rename the cookie at the next session-reset-acceptable
  release.
- **Slice:** small (copy sweep + a guard test).
- **Risk if nothing:** permanent low-grade credibility tax; the legacy name keeps re-entering new
  copy because there is no enforcement.

### 1.2 "Capability" vs "workflow" — the spec and the app contradict each other

- **What feels wrong:** the spec says capability is the public concept and workflow the
  implementation detail (`SPEC.md:21-22`), but the web app's primary nav item is **Workflows**, the
  UI copy says "A workflow is a capability your agents can invoke" (`web/views/Workflows.jsx:244`),
  MCP tools say `list_capabilities`, and the seeds' `workflow.entry` points at files in
  `workflow-templates/workflows/`. Users must hold both nouns to read any one surface.
- **Why it matters:** this is the product's central noun. Agents choosing tools and humans reading
  docs get two words for one thing and one word (`workflow`) for two things (the catalog item and
  the Smithers source behind it).
- **Recommended shape:** pick **workflow** as the only user-facing noun — it is what the web UI
  already says, what users expect from the category, and what every competitor calls it. Keep
  `capability` as an internal/API identifier for compatibility (document the synonym once in the
  API docs), and stop using it in rendered copy, MCP descriptions, and docs prose. The reverse
  choice (capability everywhere) is defensible but means renaming the UI users already see.
- **Slice:** small for copy; medium if MCP tool descriptions and docs are included.
- **Risk if nothing:** every new page and doc re-rolls the dice on which noun to use; agent-facing
  descriptions stay ambiguous.

### 1.3 Approval-adjacent word sprawl: gate, checkpoint, hold, escalation

- **What feels wrong:** "gate" alone means three unrelated things — engine `<Approval>` nodes
  (`src/approvalRoutes.js:18`), release-train gates (`src/releaseTrain.js`), and the
  `blocked_by_gate` failure class. "Checkpoint" means supervisor resume state. "Hold" is the
  engine-approval reaper shield. "Escalation" is a supervisor approval card. None of these are
  defined for users anywhere.
- **Why it matters:** an operator reading a run timeline meets five words for "a human needs to
  act or the system is protecting itself" with no glossary; support burden lands on Fran.
- **Recommended shape:** a one-page glossary in the docs, and a copy rule: user-facing surfaces say
  **approval** (a card a human resolves) and **checkpoint** (a place a workflow can pause/resume);
  gate/hold/escalation become internal vocabulary only.
- **Slice:** small.
- **Risk if nothing:** the vocabulary keeps forking as new features land (post-run hooks will add
  "hook" to the same pile).

### 1.4 MCP tool names lie about their arguments

- **What feels wrong:** `approve_run`, `reject_run`, `request_changes_run` take an `approvalId`,
  not a run id (`src/mcp.js:40-42`).
- **Why it matters:** agents pattern-match on names; a wrong guess here burns an approval action
  on the wrong object or errors confusingly.
- **Recommended shape:** `resolve_approval` (with a `decision` argument) or at minimum
  `approve_approval`-style names at the next MCP rev, keeping old names as aliases for one release.
- **Slice:** small.
- **Risk if nothing:** persistent agent misuse; this is exactly the kind of interface agents
  can't read past.

### 1.5 Deploy / publish / promote are three verbs with three mechanisms

- **What feels wrong:** "deploy" is a workflow input boolean, "publish" applies to workflow bundles
  (`POST /api/workflow-bundles`, admin) and informally to marketing content, and "promote" is a
  git merge-to-main API route labeled "Merge to main" in the web UI. None of them are defined in
  the concepts docs.
- **Why it matters:** this is the confusion that spawned this audit. A user cannot predict what
  ticking `deploy` does without reading workflow source.
- **Recommended shape:** see section 4 — one post-run-hook concept, with **promote** kept as its
  own well-named action (it is genuinely different: it merges reviewed work). Retire "publish" as
  a UI word or reserve it strictly for workflow-bundle publishing.
- **Slice:** covered by the post-run-hooks branch (large).
- **Risk if nothing:** every new side-effectful workflow invents a fourth verb.

---

## 2. Public surface and discovery

These findings are the requirements list for `runyard/sexy-public-site`. The redesign should not
ship prettier versions of the current leaks.

### 2.1 `/llms.txt` publishes the live private catalog, unauthenticated

- **What feels wrong:** `renderLlmsTxt` embeds the deployment's actual capability list — slugs,
  names, descriptions — via `hubMenuPayload`/`listCapabilities()` (`src/discoveryDocs.js:63`,
  `src/publicRoutes.js:41`), while `/api/menu` and `/api/capabilities` require auth
  (`src/serverRoutes.js:46`). It also tells anonymous visitors that the admin bootstrap token
  lives at `data/bootstrap-token.txt` (`src/discoveryDocs.js:93-95`) and names the Telegram bot
  token env vars.
- **Why it matters:** this is a per-company private deployment; the catalog *is* the company's
  internal process map. The auth gate on the menu is meaningless while llms.txt mirrors it. The
  bootstrap-token path plus the `/api/setup` dataDir leak (2.2) hands an attacker a precise map.
- **Recommended shape:** `/llms.txt` becomes a static, generic document: what Runyard is, how to
  authenticate, where the authenticated menu lives. The live catalog moves behind auth (agents
  already have tokens by the time they need it). Secret-file paths and env-var names move to the
  operator docs.
- **Slice:** small.
- **Risk if nothing:** each new capability silently widens the anonymous information surface;
  a future security review flags it at a worse time.

### 2.2 Unauthenticated `/api/setup` returns hostname and data directory

- **What feels wrong:** `GET /api/setup` has no `requireAuth` (`src/serverRoutes.js:48`) and
  returns `hostname`, `dataDir`, `instanceName`, `environment`, and Telegram configuration
  booleans (`src/authRoutes.js:6-30`).
- **Why it matters:** server filesystem paths and hostname disclosure to anonymous visitors on a
  product whose pitch is "private by default". The login page may need *some* of this
  (instance name), but not the filesystem layout.
- **Recommended shape:** split it: an unauthenticated `/api/instance` returning `instanceName` and
  auth mode only; everything else moves behind auth (the Settings page is the only consumer of the
  full payload).
- **Slice:** small.
- **Risk if nothing:** free reconnaissance; contradicts the marketing claim on the same origin.

### 2.3 Public docs are operator docs wearing a user-docs URL

- **What feels wrong:** `public/docs.html` publicly ships the full env-var reference
  (`RUNYARD_HUB_SESSION_SECRET`, `SECRETS_ENC_KEY` guidance, `IMPROVE_REPO_MAP`, lines ~201-224),
  the security model including bootstrap-token rotation, the internal hardening ladder and
  optimizer philosophy, the repo layout, and — worst — real internal hostnames:
  "`runyard.repo.box` is static docs. `hub.repo.box` is the live token-protected Hub"
  (`public/docs.html:91`), directly contradicting its own rule three sections later ("keep private
  hostnames out of code and use `hub.example.com` in docs", `docs.html:277`).
- **Why it matters:** three audiences (evaluator, agent, operator) share one page, so the page
  serves none well and leaks the operator's world to everyone. The hostname leak is a
  dogfood-deployment fingerprint shipped to every install.
- **Recommended shape:** split into **Quickstart** (public: what it is, install, first run),
  **Operating Runyard** (authenticated or at least clearly operator-scoped: env vars, security
  model, topology, secrets), and keep philosophy (hardening ladder, optimizer) in `specs/` where
  it already lives. Replace all real hostnames with `example.com` forms. This is the structural
  brief for `sexy-public-site`.
- **Slice:** medium (content restructure; the redesign branch is already doing the visual work).
- **Risk if nothing:** the redesign polishes a page whose information architecture is wrong, and
  the split becomes harder after visual investment.

### 2.4 Stale and self-contradictory public claims

- **What feels wrong:** `docs.html:51` instructs users to click a "Try it: run `hello`" button
  that does not exist on the landing page (zero matches in `landing.html`); the landing footer
  links the word "Smithers" to the Runyard repo, not the Smithers project
  (`public/landing.html:666`); README describes a landing page that "walks you through your first
  capability run", which it doesn't.
- **Why it matters:** broken promises in first-touch docs read as abandonment.
- **Recommended shape:** either build the "run hello" affordance into the redesigned landing page
  (it is a genuinely good idea) or delete the claims. Fix the Smithers link target.
- **Slice:** small.
- **Risk if nothing:** trivially discoverable rot on the highest-traffic pages.

### 2.5 Repo artifacts published or half-published by accident

- **What feels wrong:** `founder-brief/public/index.html` — a 34KB internal architecture brief with
  roadmap, failure modes, and open questions — sits in the product repo (unrouted, but shipped in
  every clone and tarball). `public/hub-hero.svg` is referenced by nothing.
  `specs/.self-update-installer-goal.md` is a stale hidden agent-goal file referencing
  `/home/xiko/smithers-hub` and an old `main` commit.
- **Why it matters:** the repo is the product for self-hosters; internal one-off artifacts in it
  are surface. The founder brief in particular reads as private strategy.
- **Recommended shape:** move the founder brief out of the product repo (or into `docs/archive/`
  if it must stay); delete `hub-hero.svg` and the hidden goal file.
- **Slice:** small.
- **Risk if nothing:** strategy docs ship to every third-party install.

---

## 3. Capability catalog shape

### 3.1 One flat list, three audiences, zero structure

- **What feels wrong:** there is no visibility model. `capabilityListQuery` filters only on
  `enabled = 1` (`src/capabilityRecords.js:119`). The 17 seeded capabilities — genuine products
  (`smart-contract-audit`, `research`, `app-skinner`, `idea-to-product`), Runyard-on-Runyard
  dogfood (`workflow-doctor`, `run-knowledge-builder`, `product-workflow`, `improve`), and pure
  infrastructure (`run-smithers`, `hello`, `runyard-smoke-check`, `runyard-support-agent`,
  `reauth-cli`) — all render in the same list in the web app, CLI, MCP `list_capabilities`, and
  (per 2.1) anonymous `llms.txt`. The only tools that soften this are a category string, a
  `supervision.internal` flag that does not affect listing, one `workflow.adminOnly` flag enforced
  only at trigger time (`src/capabilityRoutes.js:163`), and a hardcoded hide-list in the web Home
  view (`["runyard-support-agent", "reauth-cli"]`, `web/views/Home.jsx:21`).
- **Why it matters:** the spec's own bar is "The MCP interface should feel like a menu of team
  abilities, not a raw infrastructure API"
  (`specs/product-intent-and-user-expectations.md:42`). Today an agent's menu includes the support
  chat plumbing, a smoke check, and a supervisor wrapper. Every new internal workflow makes the
  menu worse. The web hide-list proves the need exists and is being solved in the wrong layer.
- **Recommended shape:** a first-class `audience` field on capabilities — `product` (humans and
  agents), `operations` (admins/operators; smoke checks, reauth, doctor tools), `internal`
  (never listed; only invoked by the system: support agent, run-smithers). List endpoints filter
  by audience against token scope; the web app gets an admin-only "Operations" section instead of
  a hardcoded hide-list; MCP lists `product` only by default.
- **Slice:** medium (schema column + seed metadata + filter in list paths + UI grouping).
- **Risk if nothing:** agents keep wasting choices on plumbing; human testers judge the product by
  its weirdest internal entries; the hide-list grows in the view layer.

### 3.2 Personal dogfood content is seeded into every fresh deployment

- **What feels wrong:** `gobbler-comic-pipeline` — a Warplet/"Gloom & Gobble" NFT-comic marketing
  pipeline with a `sidequestLane` enum (`missing-bureau`, `insurance-desk`, `auction-gossip`, …)
  and 10 brand-specific inputs — is seeded for every company that installs Runyard
  (`src/seedCapabilityProduct.js:127`). `product-workflow` defaults its target repo to the Runyard
  repo itself. `hello` sits in the public catalog as a toy.
- **Why it matters:** a third party's first catalog contains someone else's in-joke. It signals
  "this is one person's toolbox", the opposite of the productization goal.
- **Recommended shape:** split seeds into a **core pack** (shipped to everyone: research,
  implement-family, improve-family, app-skinner, smart-contract-audit, idea-to-product) and a
  **dogfood pack** loaded only when an env flag or instance name marks the deployment as the
  Runyard dev instance (gobbler, product-workflow-with-runyard-defaults). `hello` stays but
  becomes the onboarding starter, surfaced by the onboarding flow rather than the standing menu.
- **Slice:** small/medium.
- **Risk if nothing:** every screenshot, demo, and third-party install carries the comic pipeline;
  seed drift makes the split harder later.

### 3.3 Near-duplicate capabilities force a choice users can't make

- **What feels wrong:** `implement` vs `implement-change-gated` (same agent, one has git
  discipline); `improve` vs `improve-no-deploy` (same schema, write half removed); `run-smithers`
  the capability vs `supervision: { default: true }` the flag (the same supervision behavior as an
  explicit wrapper and an implicit envelope); `improve` carries a `request` field documented as
  "Back-compat alias for target" in its user-facing schema.
- **Why it matters:** the catalog asks users to resolve distinctions that are actually policy
  ("should edits be gated?" — yes) or history (aliases). The v0.11 spec already declares Hub-native
  supervision the direction, which obsoletes `run-smithers` as a user-facing choice.
- **Recommended shape:** one `implement` with gating always on (the ungated variant becomes a
  policy flag admins can loosen, not a separate menu entry); one `improve` with an `applyChanges`
  boolean replacing the two-entry split; `run-smithers` moves to `internal` audience per 3.1;
  drop the `request` alias from the schema (accept it silently server-side for old reruns if
  needed).
- **Slice:** medium.
- **Risk if nothing:** agents pick the ungated variant because its schema is simpler — the exact
  wrong default.

### 3.4 Input schemas assume operator knowledge of the runner box

- **What feels wrong:** `repoDir` asks for "absolute runner-local git repo path… inside allowed
  improve repo roots"; `repo`/`project` only resolve if you know the runner's `IMPROVE_REPO_MAP`
  JSON env; `smart-contract-audit.target` is a runner filesystem path; `idea-to-product.replaceLive`
  is documented as "Equivalent to passing --replace-live"; `run-smithers.wrappedInput` is
  schema-less ("Schema depends on the wrapped capability"). Meanwhile the actually-important
  harness selection (`piProvider`, model choice) is invisible — resolved purely from env by
  `pi-harness.js`.
- **Why it matters:** capabilities are supposed to hide workflow internals (the spec's core mental
  model). These schemas make the runner's filesystem the user interface, which no agent or
  teammate can discover; they can only ask the operator.
- **Recommended shape:** the Hub owns a **repo registry** (admin-configured list of repo keys with
  descriptions, sourced from `IMPROVE_REPO_MAP` at registration) and schemas reference registry
  keys via an enum the form/agent can render. `repoDir` becomes an admin-only escape hatch.
  CLI-flag phrasing leaves schema descriptions. Runner-env side-channels that change behavior
  (pi harness, model selection) get surfaced read-only on the workflow detail page so what-will-run
  is inspectable.
- **Slice:** medium (registry endpoint + schema updates); the read-only env surfacing is small.
- **Risk if nothing:** capabilities are unusable without pinging the operator, which caps adoption
  at exactly one user.

### 3.5 The schema is authored twice and the template directory mixes libraries with workflows

- **What feels wrong:** every workflow's inputs exist as JSON Schema in the seed *and* as Zod in
  the `.tsx` (e.g. `research.tsx:9`) with no drift check. Seven of the 24 files in
  `workflow-templates/workflows/` are imported library modules, not workflows
  (`runyard-runtime.js`, `agent-fallback.js`, `pi-harness.js`, `repo-mutation-lease.js`,
  `run-smithers-watcher.js`, `workflow-repair.js`, `improve-repo.js`) — including
  `run-smithers-watcher.js` sitting next to the `run-smithers` capability it serves. A dead input
  (`runyard-smoke-check.expectRunner`, "Reserved for future") ships in a user-facing schema.
- **Why it matters:** schema drift produces the worst failure mode — a form that validates input
  the workflow rejects. Directory ambiguity breaks any tooling (or agent) that globs the directory,
  and it already confused this audit's own inventory pass.
- **Recommended shape:** move libraries to `workflow-templates/lib/`; add a test that derives or
  at least diffs the seeded JSON Schema against the Zod schema per workflow; delete dead inputs.
- **Slice:** small.
- **Risk if nothing:** silent drift, and every future contributor re-learns which files are real.

---

## 4. Side effects: deploy, publish, promote, hooks

This is the decision area that triggered the audit. Current state, concretely:

- `deploy` is a boolean input on `implement-change-gated`, `improve`, `idea-to-product`, and
  `product-workflow`, executed inside each workflow's own code, gated by each workflow's own env
  checks (`GATED_PROD_HOST/DIR/KEY`, `REPOBOX_HOST/SSH_KEY`, `STATIC_ROOT`), with per-workflow
  special cases ("GATE FAILED: deploy=true is disabled for RunYard self-mutation runs",
  `implement-change-gated.tsx:188`).
- `idea-to-product` defaults `deploy` to **true** and offers `publicAccess` ("Deploy without auth
  if true") and `replaceLive` — a fresh install can, by default path, put a generated site on a
  live host (`src/seedCapabilityProduct.js:61-62`).
- Promotion (merge-to-main) is a separate API-only route (`POST /api/runs/:id/promote`) invisible
  to CLI and MCP despite its scope grant advertising `api|mcp` (`src/serverRoutes.js:129-130`).
- Run response endpoints — the real "post-run egress" — are fully built server-side
  (`runResponseEndpoint*`, HTTP + Telegram transports, redaction, delivery bookkeeping) but
  reachable only by hand-crafting a JSON field on the raw HTTP run-create call; neither
  `runyard run` nor the `run_capability` MCP tool exposes it.
- There is no generic post-run hook mechanism.

### 4.1 Side effects are defined by workflow code plus runner provisioning

- **What feels wrong:** what `deploy: true` *does* is unknowable from the product surface — the
  answer lives in workflow source and in which env vars an operator happened to set on which
  runner. Safety is a property of provisioning, not of the capability definition. The approver of
  a `deploy: true` run sees a boolean, not a destination.
- **Why it matters:** this is the highest-blast-radius action in the product, and it is the least
  legible. It also can't be audited: nothing records "what deploy targets exist" centrally.
- **Recommended shape:** the `post-run-hooks` branch direction, stated as a contract:
  - Admins register **named hooks** on the Hub (e.g. `deploy-prod-site`, `notify-slack`), each with
    a type, a target description, credentials via the encrypted secrets store, and an
    approval requirement.
  - Capabilities declare which hooks they may request; runs request hooks by name; the approval
    card shows the hook name and target ("will run hook `deploy-prod-site` → repo.box:/srv/site").
  - The per-workflow `deploy` booleans and env-gate special cases migrate into hooks; workflows
    stop shelling into prod themselves.
  - Run response endpoints become just another hook type (`notify-http`, `notify-telegram`) —
    which also fixes their zero-surface problem (4.3) and collapses two mechanisms into one.
- **Slice:** large (it is already its own branch); the contract above is the acceptance bar.
- **Risk if nothing:** the next side-effectful workflow adds a fourth env-gate dialect; a human
  tester ticks `deploy` on a fresh install and either hits a cryptic `GATE FAILED` (best case) or
  actually deploys (worst case).

### 4.2 `idea-to-product` defaults to deploying

- **What feels wrong:** the one seeded workflow that provisions live infrastructure defaults its
  most dangerous flag to true, and pairs it with `publicAccess`/`replaceLive` toggles.
- **Why it matters:** defaults are the product. Approval-required softens this but the approver
  sees only booleans (see 5.5).
- **Recommended shape:** `deploy` defaults false until hooks land; after hooks, "deploy" is a
  hook the admin has to have registered, so the default question disappears.
- **Slice:** small (one seed default) now; folded into hooks later.
- **Risk if nothing:** the single most likely bad-surprise during human testing.

### 4.3 Response endpoints: built, unreachable, and redundant with hooks

- **What feels wrong:** a complete validated/redacted/delivered feature
  (`src/runResponseEndpoint*.js`, `specs/run-response-endpoints.md`) whose only entry point is a
  hand-written JSON field on the raw API; its source header still narrates its build slices.
- **Why it matters:** dead-but-live surface: it must be maintained and secured but delivers no
  product value; and it will conceptually collide with post-run hooks the moment those land.
- **Recommended shape:** fold into hooks as notification hook types (4.1). If hooks are far out,
  minimally expose `--respond-to` on `runyard run`; otherwise freeze it and say so in the spec.
- **Slice:** small (freeze/note) or absorbed into hooks (large).
- **Risk if nothing:** two overlapping egress mechanisms, each half-surfaced.

### 4.4 Promote is a first-class action hiding in one surface

- **What feels wrong:** promotion has real product semantics (merge reviewed run output to main,
  with test/build gates and rollback — `src/runPromotion.js:131-226`) but exists only as an API
  route and a web button labeled "Merge to main"; no CLI verb, no MCP tool, no docs concept. Its
  candidate gate accepts run statuses (`recovered`, `approved`) that nothing ever writes
  (`src/runPromotion.js:6`).
- **Why it matters:** the gated-implement flow — the product's flagship safety story — ends in an
  action most surfaces can't perform. Agents that started a gated run can't finish the job.
- **Recommended shape:** `runyard promote <run-id>` and an MCP `promote_run` tool (this one
  genuinely takes a run id); one user-facing name — recommend **Promote** with "merge to main" as
  description; delete the phantom statuses from the gate.
- **Slice:** small/medium.
- **Risk if nothing:** parity complaints from the first agent-driven end-to-end test.

---

## 5. Approval model

The semantics underneath are mostly right — timed approvals "surface, don't decide"
(`src/approvalTimerRecords.js:8-12`), holds protect waiting runs from the reaper, the engine
bridge never invents decisions. The product expression of those semantics is where it breaks.

### 5.1 Approval kinds are implicit; statuses can't say what happened

- **What feels wrong:** five kinds exist only as payload conventions (`run_start`, generic API,
  `engine_approval`, `supervisor_escalation`, child-run holds) — "blocking vs timed" is emergent
  from whether `timeout_at` is null. The stored status enum is `{pending, approved, rejected}`;
  `changes_requested` collapses to `rejected` with the real decision stashed in a parallel field
  (`src/operatorRecords.js:102-129`), and the web UI has to un-collapse it with `decision || status`
  (`web/views/Approvals.jsx:16-22`). Engine auto-approvals are flattened to plain `approved`
  (`src/runnerEngineApprovals.js:112-114`). Timer outcomes live in a third field (`timer_state`).
- **Why it matters:** anyone filtering or auditing approvals gets lies ("rejected" that was
  actually "changes requested"; "approved" that no human approved). Every new surface must
  re-learn the three-field dance.
- **Recommended shape:** an explicit `kind` column and an honest resolution enum:
  `approved | approved_by_fallback | auto_approved | changes_requested | rejected |
  rejected_by_fallback`, with `status` reduced to `pending | resolved`. Present kind and
  resolution on all surfaces.
- **Slice:** medium (migration + presentation sweep).
- **Risk if nothing:** the audit trail — the reason approvals exist — misrepresents decisions.

### 5.2 Escalation options are decorative

- **What feels wrong:** the supervisor's escalation card carries
  `options: [retry_anyway, edit_and_retry, abandon]` (`src/hubSupervisorRepair.js:50-54`), but no
  surface renders them and the resolution model can't express them; they appear only inside the
  raw payload JSON block.
- **Why it matters:** the Hub-as-supervisor story (v0.11) hinges on escalations being decision
  points. Today the human's only levers are approve/reject on a card whose real question is
  three-way.
- **Recommended shape:** approvals optionally carry typed options; resolving with an option maps
  to a defined supervisor action. Web renders option buttons; CLI/MCP accept `--option`.
- **Slice:** medium.
- **Risk if nothing:** supervision escalations dead-end in ambiguity precisely when a human is
  most needed.

### 5.3 Approval context is thin where it counts, and uneven across channels

- **What feels wrong:** an approver of a code-changing or deploying run sees derived free-text
  ("Proposed change" is input keys and description prose, capped at 700 chars,
  `src/approvalPresentation.js:94-100`) — never a diff, plan, or destination. Telegram approvers
  see even less: no timer, no fallback, no decision-outcome text (`src/telegramApprovals.js:39-76`)
  — on timed approvals a Telegram approver can't tell that doing nothing will auto-decide.
  CLI/MCP return raw JSON with no rendering. Engine cards are generic boilerplate naming the
  `smithers approve` command.
- **Why it matters:** approvals are the product's safety mechanism; their value equals the quality
  of the moment of decision. A yes/no on invisible work trains humans to rubber-stamp.
- **Recommended shape:** define a minimum approval context contract per kind — gated code runs
  attach the staged diff (or a link to it) as an artifact referenced by the card; deploy/hook
  approvals name the hook and target; timed approvals must state the fallback on **every**
  channel, Telegram first.
- **Slice:** medium (Telegram timer line is small and should be done immediately).
- **Risk if nothing:** rubber-stamp culture; the timed-fallback feature becomes a foot-gun on the
  one channel people actually answer quickly.

### 5.4 Approvals are architecturally central and navigationally buried

- **What feels wrong:** "What still needs a human?" is one of the spec's core questions, but
  Approvals has no sidebar entry — only a topbar bell (`web/app/Shell.jsx:59-76`); the quick-list
  omits the third decision (Request changes) that the detail view offers
  (`web/components/ApprovalList.jsx:38-43`); CLI/MCP can only list *pending*, never history.
- **Why it matters:** the approval inbox is, with Runs, the product's daily-driver page for
  humans.
- **Recommended shape:** Approvals becomes a primary nav item with pending count; quick-list and
  detail offer the same decisions; CLI/MCP accept a status filter.
- **Slice:** small.
- **Risk if nothing:** approvals get resolved late; testers conclude the product has no inbox.

### 5.5 Engine-bridge operational gaps are known and will hit testers

- **What feels wrong:** documented, real, and user-visible: iteration>0 engine gates fail closed
  requiring manual `smithers approve --iteration N` (`docs/design/engine-approval-bridge.md:106-111`);
  pending engine cards on terminal runs are never auto-resolved (~60 stale cards observed in the
  wild, `:148-151`); a dead assignment loop leaves a hold forever (`:112-117`).
- **Why it matters:** stale cards pollute exactly the inbox 5.4 wants to promote.
- **Recommended shape:** a terminal-run card sweeper (auto-resolve with resolution
  `superseded_by_run_end`), a hold TTL tied to runner liveness, and an upgrade note for the
  iteration fix (fixed upstream ≥0.25).
- **Slice:** small/medium.
- **Risk if nothing:** the approval inbox arrives pre-filled with garbage on day one of human
  testing.

---

## 6. Run status model and failure taxonomy

### 6.1 Fourteen statuses where users can hold six — failure classes are statuses

- **What feels wrong:** the lifecycle graph (`src/runLifecyclePolicy.js:5-20`) has 6 lifecycle
  statuses plus **8 terminal failure statuses** that double as the failure taxonomy
  (`failed`, `blocked_by_gate`, `blocked_by_preflight`, `provider_limited`, `timed_out`,
  `invalid_output`, `infra_unavailable`, `needs_human` — `src/runFailureClass.js:1-12`). The web
  UI doesn't know the granular six exist: no icon (`web/components/ui.jsx:38-42`), and the
  diagnostics panel only branches on `failed/error/cancelled/waiting_approval`
  (`web/lib/runHelpers.js:9`) — a `timed_out` run renders a bare bullet with no "why this failed"
  card. Meanwhile five **phantom** statuses (`error`, `pending`, `rejected`, `recovered`,
  `superseded`) live in web/diagnostic code and even the promotion gate but are never written by
  the backend. The DB column has no constraint (`src/dbSchema.js:113`), so the canonical set is
  whatever JS module you ask.
- **Why it matters:** status is the primary thing every surface filters, colors, and alerts on. A
  status enum that front- and back-end disagree about guarantees dead UI branches and wrong
  filters — already observable in the diagnostics gap.
- **Recommended shape:** orthogonalize: **status** is the small lifecycle enum
  (`waiting_approval, queued, assigned, running, succeeded, failed, cancelled`) and **failure
  class** is a separate field on failed runs. Add a CHECK constraint or a single shared constant
  module both backend and web import. Delete phantom statuses; give failure classes first-class
  presentation (label + explanation + suggested action) instead of hoping each surface knows all
  fourteen strings.
- **Slice:** medium (migration is mechanical: `status LIKE` the 8 classes → `failed` + class
  column; presentation sweep follows).
- **Risk if nothing:** every new surface (post-run hooks will read terminal states too)
  re-implements a wrong status set; users see unstyled mystery states.

### 6.2 The taxonomy is defined twice and the richest layer is invisible

- **What feels wrong:** `runFailureClass.js:14-22` and `runSmithersClassification.js:4-12`
  maintain byte-identical regex tables independently. Above them sit code-vs-infra classification
  and error fingerprints (supervisor fuel), and — separately — the LLM **obstruction analysis**
  with its own severity/confidence vocabulary, written only to an artifact
  (`run-obstruction-analysis.json`) with no web/CLI view at all ("obstruction" appears nowhere in
  `web/` except a CSS comment). Also, `reconcileFailedRecoverable` rescans only `status = 'failed'`
  (`src/runSupervisorRecords.js:264`), so the classes the system itself calls *retryable*
  (`timed_out`, `infra_unavailable`, `provider_limited`) are never rescanned — the taxonomy and
  the supervisor disagree.
- **Why it matters:** duplicate regex tables will drift silently. The retryable-classes gap is a
  live behavioral bug in the Hub-as-supervisor story. And the most useful failure output the
  product produces (obstruction analysis) is invisible to the people it was built for.
- **Recommended shape:** one classification module; the supervisor rescan keys off failure class
  retryability, not the literal string `failed`; obstruction analysis gets renamed (see §9) and
  rendered as a "Run retrospective" section on the run detail page — it is already structured for
  exactly that.
- **Slice:** small (dedupe + rescan fix) plus small/medium (retrospective panel).
- **Risk if nothing:** retryable failures silently stay dead; paid LLM analysis keeps landing in
  a JSON file nobody opens.

### 6.3 Four re-execution flavors share two words

- **What feels wrong:** user **rerun** creates a new run; supervisor **resume** requeues the same
  run from checkpoint; supervisor **repair** dispatches a fix child then re-runs the parent fresh
  — and calls that lineage action `"rerun"` (`src/runSupervisorRequeue.js:80-81`), colliding with
  the user verb; **promotion** is orthogonal but appears in the same lineage/timeline stream.
  Lineage actions (`resume, rerun, repair, escalate, give_up`) and escalation reasons
  (`three_strike`, `loop_breaker`, `code_repair_exhausted`) surface raw in cards and timelines.
- **Why it matters:** the self-heal story is a differentiator, but as presented it is
  unexplainable: a user watching a run's history cannot answer "what did the system do and why".
- **Recommended shape:** a fixed, documented verb set — user verbs **Rerun** and **Promote**;
  system verbs **Resumed**, **Repaired**, **Escalated**, **Gave up** — with humanized one-line
  explanations in the timeline; rename the internal repair-requeue action to `requeue_fresh`.
- **Slice:** small.
- **Risk if nothing:** the feature most worth demoing reads as noise.

---

## 7. Web app information architecture

### 7.1 Admin isn't gated, and the one gate that exists is in the wrong layer

- **What feels wrong:** `Shell.jsx:83` computes `meIsAdmin(me)` and never uses it — every user
  sees the Admin dropdown (Connect & Tokens, Runners, Audit, Settings & Secrets). Non-admins can
  open Tokens and tick the **admin** scope checkbox on token creation (`web/views/Tokens.jsx:9`);
  enforcement is API-only. Only Secrets self-gates (`web/views/Secrets.jsx:548`). Meanwhile
  Agents/Skills/Knowledge CRUD — raw-JSON editing of shared company context — is a primary nav
  item with no gating for any logged-in user, while the API restricts writes to admin, so the UI
  offers forms that will 403.
- **Why it matters:** the security model survives (API enforces), but the product model doesn't:
  non-admins are shown levers that fail on pull, which reads as broken, and the admin surface
  advertises itself to everyone.
- **Recommended shape:** wire the existing flag: hide admin nav and admin-scope checkboxes for
  non-admins; gate or hide catalog write affordances by scope; keep Secrets' pattern as the
  template.
- **Slice:** small — the flag already exists.
- **Risk if nothing:** first multi-user test produces a pile of "buttons don't work" reports.

### 7.2 Raw enums and dev jargon are the app's voice

- **What feels wrong:** `StatusBadge` renders the raw enum as the visible label — users literally
  read `waiting_approval`, `superseded` (`web/components/ui.jsx:45-53`); the diagnostics panel
  labels a `<code>` block "Failure event: `run.blocked_by_gate`"
  (`web/components/RunDetailParts.jsx:200`); a tab is labeled `workflowGraph`
  (`web/views/WorkflowDetail.jsx:101`); copy says "wrapper retries and repair lineage"
  (`web/views/Home.jsx:366`), "Bin names match the current build" (`web/views/Connect.jsx:92`);
  empty states cite `SMITHERS_RUNNER_CONCURRENCY=4` (`web/views/Runners.jsx:198`). The status
  filter dropdown humanizes but the active-filter chip shows the raw enum on the same page.
- **Why it matters:** individually trivial; collectively they set the register of the whole
  product as "internal tool", which contradicts the productization goal. This is also the
  cheapest large win available.
- **Recommended shape:** one `humanizeStatus()`/label map used everywhere a status renders; a copy
  pass over the ~10 jargon strings; env-var mentions move into collapsible "operator details".
- **Slice:** small.
- **Risk if nothing:** human testers' first impression is unfinishedness, regardless of how solid
  the engine is.

### 7.3 Honesty bugs: controls that don't do what they say

- **What feels wrong:** "Send test ping" only refetches the runner list — the code comment admits
  no ping endpoint exists (`web/views/Runners.jsx:180-182`). Deep-links with `focus=logs/artifacts`
  render the sentence "Linked directly to this run's log." instead of navigating
  (`web/views/RunDetail.jsx:126-127`). The catch-all route still says "This view is being ported
  to the new React + TanStack frontend" (`web/views/Placeholder.jsx:12`).
- **Why it matters:** fake affordances destroy trust faster than missing ones.
- **Recommended shape:** rename the button "Refresh" (or build the ping), make focus deep-links
  scroll/open the section, replace Placeholder copy with a plain not-found message.
- **Slice:** small.
- **Risk if nothing:** testers file these as bugs; each costs more triage than the fix.

### 7.4 Duplicated and unowned surfaces

- **What feels wrong:** Secrets and Tokens are each mounted twice (standalone routes and embedded
  in Settings/Connect); the three starter templates are duplicated verbatim in `Workflows.jsx` and
  `Onboarding.jsx` — and two of the three are fake (`echo summarize $url`); onboarding exists as
  both a wizard and an embedded card; the queue banner and masked secret input are each
  implemented twice; `components/HomeChrome.jsx` is dead; `#brand` is a full style-guide page with
  no nav entry shipped to production.
- **Why it matters:** double-mounted surfaces drift (the two approval lists already offer
  different actions); fake templates teach wrong lessons in the first five minutes.
- **Recommended shape:** one route per surface (Settings & Secrets, Connect & Tokens as the
  canonical homes); one shared starter-template module with real templates; delete HomeChrome;
  Brand moves behind admin or into docs.
- **Slice:** small.
- **Risk if nothing:** compounding drift; onboarding teaches users with placeholder workflows.

### 7.5 Missing pages the spec already promises

- **What feels wrong:** the spec's web questions include "What artifacts were produced?" — but
  there is no artifacts browser; artifacts exist only inside a run's detail (server-side search
  exists: MCP `search_artifacts`). Knowledge has no search UI despite MCP `search_knowledge`.
  There is no failures/attention view beyond filtering Home. Agents/Skills/Knowledge editing is a
  raw JSON textarea (`web/views/Agents.jsx:146-152`). The support chat FAB (37KB of UI) is mounted
  globally but absent from the nav model.
- **Why it matters:** the durable record is the product's payload; if artifacts and knowledge
  can't be browsed, the record exists but the value doesn't.
- **Recommended shape:** an Artifacts page (search + filter by run/workflow/type) and knowledge
  search within the Agents page; structured forms for the three catalog editors; a deliberate
  decision about where Assistant lives in the IA.
- **Slice:** medium (artifacts page), small (knowledge search), medium (editors).
- **Risk if nothing:** the "durable company record" pitch is unverifiable from the UI.

---

## 8. MCP / API / CLI parity and readiness

### 8.1 Core run verbs exist on one surface each

- **What feels wrong:** **rerun** and **promote** are API-only despite their routes granting
  `api|mcp` scope (`src/serverRoutes.js:129-130`) — no CLI verb, no MCP tool. **Tail/timeline** is
  CLI-only — MCP agents that start runs have no watch primitive beyond polling status/logs.
  **Schedules** are API-only (and admin). **Secrets** have no CLI. CLI can't search artifacts; MCP
  can. CLI/MCP can't list approval history (both hardcode pending).
- **Why it matters:** the spec's parity promise ("CLI should expose the same operational concepts
  as MCP", and MCP is the primary agent surface) fails exactly on the completion verbs — an agent
  can start gated work but cannot finish (promote) or retry (rerun) it.
- **Recommended shape:** parity for the run lifecycle first: `rerun`, `promote`, and a
  `get_run_timeline` MCP tool + `runyard rerun/promote`. Then a deliberate, documented
  non-parity list (schedules/secrets/tokens = admin surfaces, API+web only) so gaps are decisions,
  not accidents.
- **Slice:** small/medium.
- **Risk if nothing:** the first serious agent integration hand-rolls HTTP calls, bypassing the
  surfaces you actually maintain.

### 8.2 Scopes: a phantom, a mismatch, and unexplained asymmetries

- **What feels wrong:** the `approvals` scope is accepted by approval routes
  (`src/serverRoutes.js:139-142`) but can only ever be minted by Telegram-webapp sessions — no
  token-create path offers it. CLI `token-create` defaults to `api,mcp,runner` (`src/cli.js:359`)
  while the server defaults to `api,mcp` (`src/tokenRoutes.js:4`) — the CLI silently over-grants
  runner (lifecycle-write) scope. A runner token can cancel runs but not rerun them, with no
  stated rationale.
- **Why it matters:** scopes are the entire authz model of a token-only product; they must be
  boringly predictable.
- **Recommended shape:** document the scope matrix in one place; make `approvals` mintable (it is
  a genuinely useful least-privilege scope for approval bots) or remove it from route checks;
  align the CLI default to the server's `api,mcp`.
- **Slice:** small.
- **Risk if nothing:** over-privileged tokens in the wild from day one, created by the product's
  own defaults.

### 8.3 Runner provisioning is local-only and model config is a side-channel

- **What feels wrong:** `runner setup`/`start` are purely local CLI (fine), but there is no remote
  story beyond install.sh, and no product surface shows **which models/harnesses a runner will
  actually use** — model selection is entirely env (`RUNYARD_*_MODEL`, pi-harness env resolution),
  invisible until a run behaves unexpectedly. The reauth flow is genuinely good (device-code
  surfacing, token material never emitted) but its UI copy is a wall of env-var and CLI trivia.
- **Why it matters:** "which brain executes my capability" is a product question operators will
  ask constantly; today the answer requires shelling into the runner.
- **Recommended shape:** runners report their resolved config (agent CLIs present, versions,
  models, pi endpoints — names only, no secrets) in their heartbeat; the Runners page shows it.
  This is observability, not new config machinery.
- **Slice:** medium.
- **Risk if nothing:** every model/harness misconfiguration becomes an SSH debugging session.

---

## 9. Rename / reframe

- **Runyard** everywhere; "RunYard" and "Smithers Hub" leave all rendered copy
  (`public/landing.html`, founder brief title, specs headers). Enforced by test.
- **One catalog noun:** recommend **workflow** user-facing; `capability` becomes API-internal
  synonym documented once (see 1.2).
- **MCP approval tools:** `approve_run`/`reject_run`/`request_changes_run` → `resolve_approval`
  (they take approval ids).
- **Statuses:** humanized labels everywhere (`waiting_approval` → "Waiting for approval");
  failure classes get plain-language names ("Blocked by gate" → "Stopped at a safety gate",
  `needs_human` → "Needs a human decision") with the enum available in tooltips/JSON only.
- **"Obstruction analysis"** → **Run retrospective** (artifact and event names included at next
  compatible rev). "Obstruction" is engine-room language for what is actually the product's most
  user-valuable failure output.
- **Lineage/supervisor vocabulary:** user-visible verbs become Resumed / Repaired / Escalated /
  Gave up; internal reasons (`three_strike`, `loop_breaker`) get sentence-form presentation and
  stay in payloads only.
- **"Merge to main" vs promote:** pick **Promote** as the verb, describe as "merge to main";
  use the same word in web, CLI, MCP, and events.
- **`shub_session` cookie** → `runyard_session` at a session-reset-tolerable release.
- **`workflowGraph` tab label** → "Graph source" (or fold into the Visual graph tab).
- **"Send test ping"** → "Refresh" until a ping exists.
- **classification field** (`runOutcomePresentation.js:278`) currently echoes `run.status` under
  the name "classification" — rename the field or make it carry the real failure class.

---

## 10. Remove / retire (delete, or make internal)

- **`gobbler-comic-pipeline` out of default seeds** — dogfood seed pack only (3.2).
- **`run-smithers` out of the user-facing menu** — `internal` audience; Hub-native supervision
  (v0.11) is the stated direction and the envelope flag already exists.
- **`improve-no-deploy` and standalone ungated `implement`** — collapse into their siblings as
  flags/policy (3.3).
- **`request` back-compat alias** in the `improve` schema; **`expectRunner`** dead input in
  `runyard-smoke-check`.
- **Phantom run statuses** `error`, `pending`, `rejected`, `recovered`, `superseded` from web
  sets, diagnostics, `ui.jsx`, and the promotion gate (6.1).
- **Duplicate failure-regex table** in `runSmithersClassification.js` (6.2).
- **Run response endpoints as a standalone mechanism** — fold into post-run hooks or freeze
  explicitly (4.3).
- **`founder-brief/`** out of the product repo; **`public/hub-hero.svg`** (orphaned);
  **`specs/.self-update-installer-goal.md`** (stale hidden agent-goal file).
- **`web/components/HomeChrome.jsx`** (dead); **Placeholder migration copy**; duplicated starter
  template arrays (keep one module).
- **Live catalog + bootstrap-token guidance in `/llms.txt`** (2.1) and **`dataDir`/hostname in
  unauthenticated `/api/setup`** (2.2).
- **Real hostnames** (`repo.box`) from public docs (2.3).
- **Workflow library modules** out of `workflow-templates/workflows/` into `lib/` (3.5).

## 11. Make admin-only (or scope-gated)

- **Web Admin nav, Tokens page, and the `admin` scope checkbox** — hidden for non-admins using
  the already-computed flag (7.1).
- **Agents/Skills/Knowledge write affordances** — match the API's admin-only writes (7.1).
- **Operations-tier capabilities** (`runyard-smoke-check`, `workflow-doctor`, `reauth-cli`,
  `run-knowledge-builder`) — `operations` audience, admin-visible; `reauth-cli`'s trigger-time
  admin check stays as defense in depth (3.1).
- **Dangerous workflow inputs pending hooks:** `workflow-doctor apply=true`,
  `product-workflow execute=true`, `idea-to-product deploy/publicAccess/replaceLive` — require
  admin scope or an admin-resolved approval, not just any approver (4.2).
- **`repoDir` raw-path inputs** — admin-only escape hatch once the repo registry exists (3.4).
- **Full `/api/setup` payload** — auth-gated; anonymous callers get instance name + auth mode
  only (2.2).
- **`/llms.txt` live catalog section** — authenticated menu only (2.1).
- **Brand page** — admin or docs, not an unauthenticated-adjacent app route (7.4).

## 12. Readiness checklist before human testing

Ordered: trust boundary, then honesty, then legibility.

- Gate the web admin surface (7.1) and align CLI token-scope defaults with the server (8.2).
- Strip the live catalog and bootstrap-token guidance from `/llms.txt`; reduce anonymous
  `/api/setup`; replace `repo.box` hostnames in public docs (2.1–2.3).
- Flip `idea-to-product` `deploy` default to false until post-run hooks land (4.2).
- Trim the seed catalog: dogfood pack split, internal audience for plumbing — testers should see
  6–8 workflows that all make sense (3.1, 3.2).
- Humanize status labels and failure classes app-wide; give the six granular failure statuses
  icons and diagnostics coverage so `timed_out` runs explain themselves (6.1, 7.2).
- Fix honesty bugs: "Send test ping", focus deep-links, Placeholder copy, "Try it: run hello"
  docs claim, Smithers footer link (2.4, 7.3).
- Approvals in primary nav; identical decision sets on list and detail; Telegram cards state
  timer + fallback (5.3, 5.4).
- Sweep stale engine-approval cards and add terminal-run card hygiene so the inbox starts clean
  (5.5).
- Fix the supervisor rescan gap so retryable failure classes are actually retried (6.2).
- Rerun + promote reachable from CLI and MCP (8.1).
- Verify `pnpm test` green and one end-to-end dogfood pass: run a gated implement from MCP,
  approve from Telegram, promote from CLI — the three-surface story testers will actually try.

## 13. Suggested next implementation branches

- `runyard/web-admin-gating` — small. Wire `meIsAdmin` through Shell/Content, hide admin nav and
  admin-scope checkbox, align CLI token defaults. Highest safety-per-line.
- `runyard/status-humanization` — small. Label maps for statuses/failure classes/lineage verbs;
  jargon copy pass; honesty-bug fixes (ping, deep-links, placeholder).
- `runyard/discovery-lockdown` — small. Static llms.txt, `/api/setup` split, hostname scrub,
  stale-claim fixes. Pairs with (and unblocks) `sexy-public-site`.
- `runyard/catalog-audience` — medium. `audience` field, seed pack split (core vs dogfood),
  audience-filtered list endpoints, web Operations section, MCP product-only default.
- `runyard/approval-resolution-model` — medium. Kind + honest resolution enum, actionable
  escalation options, Telegram timer/fallback line, stale engine-card sweeper.
- `runyard/run-status-orthogonalization` — medium. Status vs failure-class split, shared constants
  module, phantom-status removal, classifier dedupe, supervisor rescan fix, retrospective panel.
- `runyard/lifecycle-parity` — small/medium. CLI+MCP rerun/promote, MCP timeline tool, approval
  history filters.
- `runyard/post-run-hooks` — already active, large. Absorbs deploy booleans, response endpoints,
  and the deploy/publish vocabulary per section 4; the contract in 4.1 is the acceptance bar.

---

*Compiled from targeted reads and six parallel surface inventories over `public/`, `web/`, `src/`,
`workflow-templates/`, `specs/`, and `docs/`; spot-checks verified against source cited inline.
No product code was changed on this branch.*
