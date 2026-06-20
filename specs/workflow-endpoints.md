# Authenticated Workflow Endpoints

## Primitive

Authenticated Workflow Endpoints are fixed-purpose HTTP intake points that let trusted app servers enqueue a constrained Runyard workflow without exposing the general capability runner API.

The first seeded endpoint is `runyard-mobile-feedback`. It accepts feedback from Fran's apps and queues `improve-no-deploy` against the Runyard `smithers-hub` project/repo binding.

## First Use Case

A feedback form posts user/app feedback to:

```text
POST /api/workflow-endpoints/runyard-mobile-feedback
Authorization: Bearer <endpoint secret>
```

The caller can provide feedback text plus source metadata such as app, user, session, URL, route, category, and severity. The caller cannot choose the workflow, repo, deploy behavior, runner, branch, tags, or approval behavior.

## Security Model

Submitted feedback is untrusted data. It is wrapped into the workflow input as evidence for review, never as instructions. The endpoint prompt and workflow both label it as untrusted user-provided data.

Each endpoint has its own bearer secret hash. Secrets are not returned by APIs, not included in frontend assets, and are excluded from audit records. A seeded local secret is generated only on the Hub machine when no environment-provided secret exists.

## Constraints

- Fixed workflow/capability: `improve-no-deploy`.
- Fixed repo/project binding: `project=runyard`, `repo=smithers-hub`.
- No deploy permission or deploy input.
- Request payload size limit per endpoint.
- Rate limiting per endpoint.
- Dedupe by payload hash within a configured window.
- Audit log records endpoint slug, queued run id, source app/user/session metadata, payload hash, and payload byte size.
- Run event records the endpoint enqueue without raw secret material.

## Future Shape

Additional endpoints can be seeded or created through admin API using the same model: endpoint slug, secret hash, fixed capability slug, fixed project/repo binding, payload limit, rate limit, dedupe window, and small endpoint config. Future work can add secret rotation, richer per-endpoint transforms, and UI management without changing the core invariant that callers submit data to a preconfigured workflow rather than choosing execution parameters.
