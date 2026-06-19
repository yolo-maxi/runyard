# Goal: Build A Runyard Run Knowledge Loop

## Context

Runyard should improve its skills, agents, and workflows by analyzing previous runs and turning run evidence into better building blocks for future runs.

The product direction is:
- Analyze completed, failed, cancelled, and waiting Runyard runs.
- Extract durable lessons, failure patterns, missing gates, reusable prompt improvements, workflow/agent/skill improvements, and knowledge resources.
- Make those findings visible and actionable in the Hub, not buried in logs.
- Keep this private and local-first. Do not leak tokens, logs, paths, or secrets.

Project:
- Repo: this Runyard repository.
- Production/live smoke URLs are deployment-specific. Use `https://hub.example.com` in docs and configure real hosts through runner environment variables.
- If your serving host is separate from your build host, keep build/test/agent execution on the worker host.

## What To Build

Implement a focused first version of a "Run Knowledge Builder" capability/workflow.

Preferred shape:
1. Add a Hub capability named something like `run-knowledge-builder`.
2. Add a Smithers workflow template under `workflow-templates/workflows/`.
3. The workflow should inspect recent Hub runs and produce structured outputs:
   - run sample summary
   - recurring failure modes
   - reusable lessons
   - suggested skill updates
   - suggested agent instruction updates
   - suggested workflow/template improvements
   - recommended next actions, with confidence
4. It should produce at least one artifact/report that is easy to read from a run detail page.
5. It should not automatically mutate live skills/agents/workflows unless there is an explicit approval/checkpoint. First version can be recommendation-only if that fits the existing architecture better.
6. Add UI/API support if useful, but keep scope tight. A clear capability plus run artifacts is enough for v1.

## Evidence Sources

Use existing Hub data structures before inventing new storage:
- `runs`
- `run_events`
- `artifacts`
- `approvals`
- `knowledge_resources`
- existing diagnostics support in run detail

If you add DB/schema/API helpers, follow existing patterns and tests.

## Product Requirements

- The feature should feel like a compounding loop: every batch of runs can teach the system something.
- It must distinguish evidence from inference.
- It must redact tokens/secrets from logs and artifacts using the existing redaction/security patterns.
- It should link back to run ids/deep links where helpful.
- It should be useful even with a small number of recent runs.
- It should support filters/inputs like capability slug, status, lookback/count, and focus area if natural.
- It should avoid noisy generic advice.

## Engineering Constraints

- Use `pnpm`, never npm.
- Follow existing code style and local helpers.
- Keep edits scoped.
- Do not run builds/tests on a serving-only host.
- Do not expose secrets from `data/`, `.env`, tokens, or raw logs.
- Do not overwrite unrelated changes.
- Commit only intentional changes.

## Verification Gates

Loop until clean or document a real blocker:
- `pnpm test`
- Verify seeded catalog/API exposes the new capability.
- If deployed, verify the deployment-specific `/healthz`, `/app`, and `/openapi.json` routes.
- Prefer a local or live smoke run if the runner setup is available without violating serving/build separation. If not possible, explain why and verify the workflow source/tests instead.

## Deliverables

- Code committed to `main`.
- Push to `origin/main`.
- Deploy to `prod` only after tests pass and the change is safe.
- Update the project brief or release notes with what shipped.
- Report:
  - commit hash
  - tests run
  - live verification
  - capability/workflow deep link, e.g. `https://hub.example.com/app#workflows/run-knowledge-builder`
  - any follow-up ideas
