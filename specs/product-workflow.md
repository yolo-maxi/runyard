# Product Workflow (sequential) — spec

Capability slug: `product-workflow` · Display name: **Product Workflow (sequential)** · Category: Product
Source: `workflow-templates/workflows/product-workflow.tsx` · Seed: `src/seeds.js`

## Intent

A sequential product-development pipeline for the Runyard app. It researches
competitors and maps their features, synthesizes a feature map against what
Runyard already has, prioritizes the gaps, then dispatches one gated
implementation per feature — **strictly one at a time** so two builders never
edit the repo concurrently. Prioritized features land on `main` through the
existing safety gates, so there are no merge conflicts.

This is the local realization of the request: *"research competitors and map
their features, prioritize features and spin out implement workflows to build
those features, make it all sequential to avoid merge conflicts and push
straight to main, for the main Runyard app."*

## Shape

```
baseline → research → featureMap → prioritize → dispatch
```

1. **baseline** — record the starting `HEAD` and resolve the target Runyard repo
   via `resolveImproveRepo` (same contract as `improve` / `implement-change-gated`).
2. **research** — a researcher agent inspects Runyard's own current features,
   then maps up to `maxCompetitors` competing/adjacent products and their
   notable features, with sources.
3. **featureMap** — a PM agent synthesizes a feature map (feature × competitors ×
   does-Runyard-have-it × gap) grounded in the current codebase.
4. **prioritize** — the PM ranks the gaps into at most `maxFeatures` features,
   each written as a self-contained, buildable `workPrompt` with a verifiable
   acceptance check and a conventional commit message.
5. **dispatch** — sequential implementation. See below.

## Sequential dispatch (no merge conflicts)

The dispatch step reuses the **`implement-change-gated`** contract rather than
inventing a parallel swarm. For each prioritized feature, in rank order, it
creates one `implement-change-gated` Hub run and **waits for it to reach a
terminal state before starting the next one**. Because runs are strictly serialized
against a single repo, no two builders ever edit it at once, and each feature is
committed and pushed before the next begins.

Each child run carries the same repo selector the product workflow resolved
(`repo` default `smithers-hub`, or `repoDir` / `project`) and `targetBranch`
(default `main`), so every implementation runs `pnpm test`, produces a sane
commit, and pushes straight to `main` through the gates already used by Runyard.
If a feature's run fails, the line stops so a half-applied change is never
followed by another builder.

### Plan vs execute

- `execute=false` (default) — **plan only**. No Hub calls, no edits. The report
  lists the competitors mapped, the feature map, the prioritized features, and
  the exact `implement-change-gated` payloads it *would* create.
- `execute=true` — queue the gated runs sequentially as described above. Needs
  `SMITHERS_HUB_TOKEN` (or `PRODUCT_WORKFLOW_HUB_TOKEN`) and `SMITHERS_HUB_URL`
  on the runner, exactly like `run-knowledge-builder`.

The `dispatch` output (and the `product-workflow-report.md` artifact) always
make explicit which competitors/features were mapped, what was prioritized, and
which implementation runs were **created or would be created**.

## Inputs

| field | type | default | notes |
| --- | --- | --- | --- |
| `context` | string | "" | positioning, users, known competitors, constraints |
| `competitors` | string | "" | optional named competitors (comma/newline) to map first |
| `maxCompetitors` | number | 5 | 1–12 |
| `maxFeatures` | number | 3 | 1–8; how many features to (plan to) build |
| `execute` | boolean | false | false = plan, true = queue gated runs sequentially |
| `deploy` | boolean | false | forwarded to each implementation run |
| `targetBranch` | string | "main" | branch each implementation pushes to |
| `repoDir` / `repo` / `project` | string | `repo="smithers-hub"` | runner-local repo resolution, same as `improve` |

## Safety & recovery

- **Execution**: product workflow runs directly. Runner death, pauses, and
  workflow failures surface through normal run status, events, approvals, and
  operator recovery rather than a wrapper workflow.
- **Approval**: `approvalPolicy.required: true` — it runs agents and can queue
  gated runs that commit, push to `main`, and may deploy.
- **Gates preserved**: implementation work flows through `implement-change-gated`
  (`pnpm test` → staged diff → sane commit → push → optional deploy). Build/test
  work happens on the runner (Hetzner); `repo.box` stays publish/serve-only.
- **Scope**: research and PM agents are read-only; only the gated child runs edit
  the repo, one at a time.

## Verification

- `pnpm test` (includes `tests/product-workflow.test.js`).
- The capability is seeded, source-viewable (`/api/capabilities/product-workflow/source`),
  carries the expected input schema, and is supervised by default — all asserted
  in `tests/product-workflow.test.js`.
