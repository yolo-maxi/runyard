# Goal: Authenticated Workflow Endpoints for Feedback Intake

Implement Fran's requested Runyard primitive: authenticated workflow API endpoints, starting with a feedback form intake that can enqueue a constrained `improve-no-deploy` style workflow run.

Context:
- Repo: `/home/xiko/smithers-hub`
- Product: private Hub/Runyard control plane at `hub.repo.box`
- Topic: Telegram RunYard topic
- Current production commit before this work: `eb852bb Complete mobile approvals nav badge`
- Existing conventions:
  - Node/Express app in `src/server.js`
  - Static app in `public/app.js` / `public/styles.css`
  - Capabilities/workflows in `workflow-templates/workflows/`
  - Tests under `tests/`
  - Package manager: pnpm only
  - Repo.box is publish/serve-only. Do not build/test/run agents on repo.box.

User request:
- "Please implement this. Maybe pass it through a product planning phase first?"
- "This" means authenticated API endpoints for workflows.
- Clean first use case: a feedback form in one of Fran's apps submits feedback to Runyard, which enqueues an `improve-no-deploy` workflow.

Product planning phase first:
1. Inspect the current capability/run creation API, auth/session/token model, tests, and public app UI.
2. Add or update a concise product/spec doc under `specs/` that describes:
   - the primitive name, e.g. Workflow Endpoints / Authenticated Workflow Endpoints;
   - the first feedback endpoint use case;
   - security model: submitted feedback is untrusted data, never instructions;
   - endpoint constraints: fixed allowed workflow/capability, fixed project/repo binding, max payload size, rate limiting/dedupe, no deploy permission, auditability;
   - future extension shape without overbuilding now.
3. Then implement the smallest useful version that matches the spec.

Implementation requirements:
- Add an `improve-no-deploy` capability/workflow if it does not already exist.
  - It must produce proposals/issues/patch suggestions only.
  - It must not deploy.
  - It must clearly wrap user feedback as untrusted input/data.
  - It should be usable both from Hub and from workflow endpoints.
- Add authenticated workflow endpoint support.
  - Prefer a simple first-class model over hardcoded one-off routes if it is not too large.
  - A first route can be something like `POST /api/workflow-endpoints/:endpointSlug` or `POST /api/endpoints/:endpointSlug`.
  - Ship one seeded endpoint for Runyard mobile/app feedback if that fits existing architecture.
  - Example intent: endpoint receives app/user feedback, validates it, and queues `improve-no-deploy` with a constrained Runyard/smithers-hub repo context.
- Auth:
  - Support server-to-server endpoint auth with a per-endpoint secret/API key or HMAC-style bearer token, whichever fits current Hub patterns best.
  - Do not expose secrets in frontend assets.
  - Keep tokens out of logs and artifacts.
- Safety:
  - Treat feedback/body fields as untrusted data.
  - Enforce payload size limits.
  - Add basic dedupe/rate-limit protection if the repo has an existing pattern. If not, add a small in-process/SQLite-backed approach without turning this into a large subsystem.
  - Audit events should show endpoint slug, queued run id, source app/user/session metadata if present, and payload hash, not raw sensitive tokens.
  - The endpoint must not allow callers to choose arbitrary workflow slug, repo path, deploy=true, or runner tags.
- UI/docs:
  - Add enough docs or UI surface so Fran can discover/use the endpoint.
  - If adding UI, keep it mobile-friendly: no horizontal overflow, tap targets around 44px, long IDs wrap, concise copy.
  - Avoid huge admin panels unless needed.
- Tests:
  - Add focused tests for:
    - unauthorized endpoint request rejected;
    - authorized feedback request queues the constrained workflow/run;
    - caller cannot override workflow/repo/deploy permission;
    - payload size/dedupe/rate-limit/audit behavior as implemented;
    - `improve-no-deploy` exists and does not include deploy behavior.
  - Update existing tests only as needed.

Verification gates:
- `pnpm test`
- If UI/static changed, run a small mobile/narrow viewport or static structure check where practical.
- `git diff --check`
- Leave the repo clean except for intentional changes.

Deliverable:
- Commit the completed implementation to the local repo with a clear message.
- Do not deploy unless the code is tested and you are confident it is safe.
- In your final tmux report, include:
  - product plan summary;
  - files changed;
  - test results;
  - commit hash;
  - any deployment notes or blockers.
