# Runyard Specs (codebase: smithers-hub)

This folder is the durable product and architecture record for Runyard (public name) / Smithers Hub (codebase name).

## Core Specs

- `product-intent-and-user-expectations.md` — product model and user expectations.
- `implementation-decisions.md` — current architecture decisions and tradeoffs.
- `acceptance-and-manual-tests.md` — acceptance criteria and manual test coverage.
- `workflow-hardening-and-optimizer.md` — workflow hardening philosophy, optimizer loop, and agent-to-code gradient.
- `workflow-endpoints.md` — authenticated fixed-purpose workflow intake endpoints.
- `run-response-endpoints.md` — optional per-run response endpoint contract (http/telegram); polling by `runId` remains canonical.
- `product-workflow.md` — sequential product-development pipeline (research → feature map → prioritize → gated implementation) for the Runyard app.

Read in this order:

1. `product-intent-and-user-expectations.md`
2. `implementation-decisions.md`
3. `acceptance-and-manual-tests.md`

The top-level `SPEC.md` is the short product contract. The files here explain the intent behind the contract, the expectations users should have, and the implementation decisions made while building the first production deployment.
