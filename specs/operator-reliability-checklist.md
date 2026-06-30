# RunYard Operator Reliability Checklist

Use this before debugging, releasing, or reporting RunYard state.

## Live Topology

- Source/build host: Hetzner, `/home/xiko/runyard`.
- Live Hub: `https://runyard.repo.box`, routed to Hetzner `127.0.0.1:43117`.
- repo.box is publish/serve-only. Do not build, test, install, or run agents there.
- CVM/dstack deployment consumes tagged GHCR images; release reports should include digest-pinned hub and runner refs.

## Before Coding

- Confirm this topic is bound to `/home/xiko/runyard`.
- Read this checklist plus `/home/xiko/clawd/memory/projects/smithers-hub.md`.
- Check `git status --short` and preserve unrelated dirty files.
- Prefer an existing RunYard/Smithers workflow for large multi-stage work; use direct edits only for focused patches.

## Before Reporting A Release

- Run focused tests for the touched area.
- Run `pnpm test`.
- Run `pnpm build`.
- Verify served bundle or service state when the change is live.
- If cutting a CVM release, wait for GitHub CI/GHCR and report immutable image digests.

## Reliability Triage

- Classify terminal failures before retrying:
  - `blocked_by_preflight`: missing workflow/repo/auth/env/tag/write path.
  - `blocked_by_gate`: deterministic build/test/lint/eval gate failed.
  - `provider_limited`: model/provider quota, 429, temporary capacity.
  - `timed_out`: runner or Smithers deadline exceeded.
  - `invalid_output`: schema/structured-output failure.
  - `infra_unavailable`: runner/network/disk/process unavailable.
  - `needs_human`: approval or manual decision required.
- Retry only transient/provider/infra failures. Do not blindly retry gate, preflight, or invalid-output failures.
- For large prompts or inputs, verify they are streamed through stdin or files, not passed as one argv argument.

## Evidence To Capture

- Run id and deep link.
- Status and failure class.
- Runner id/name and auth health.
- Capability slug/version and workflow entry.
- First failing node/step.
- Test/build command output summary, not full logs.
