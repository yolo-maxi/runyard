# Product Intent and User Expectations

## Naming

The product is published as **Runyard** ("self-hosted control plane for agent runs"). The codebase, package, bin names, and environment variables keep the `smithers-hub` prefix. In this document the terms are interchangeable; new user-facing copy should prefer "Runyard".

## Product Intent

Runyard is a private, self-hosted capability operating system for company agents.

The product exists to centralize the work that usually gets scattered across local agent sessions: available workflows, team skills, agent roles, knowledge, run history, logs, artifacts, and human approvals. The Hub should make it obvious what agents can do, what inputs each action needs, where work ran, what happened, what was produced, and what still needs a human decision.

The core mental model is:

- Agents consume capabilities.
- Capabilities hide workflow internals.
- Workflows execute through local or remote runners.
- Humans supervise runs, artifacts, and approvals.
- The Hub keeps the durable company record.

The product is intentionally not a public SaaS in this version. It is productized for private installation: each company deploys its own Hub on its own domain and controls access tokens on its own machine.

## Primary Users

### Local Agents

Local agents are the main consumer. They should interact with Smithers Hub through MCP and CLI, not by scraping the Web UI or learning internal workflow implementation details.

Expected behavior:

- An agent can list available capabilities.
- An agent can search by intent or keyword.
- An agent can inspect input/output schemas before running anything.
- An agent can understand required runner tags, skills, agents, and approval policy.
- An agent can start a run and receive a run ID.
- An agent can poll status, logs, events, artifacts, and final output.
- An agent can approve or reject approval requests when authorized by the local human/operator.

The MCP interface should feel like a menu of team abilities, not a raw infrastructure API.

### Humans

Humans mainly use the Hub to supervise.

Expected behavior:

- A human can log in with a long-lived browser session after entering an access token.
- A human can see the capability catalog.
- A human can edit capabilities, agents, skills, and knowledge resources.
- A human can inspect run history and current run state.
- A human can open a workflow and see Overview, Visual graph (ReactFlow), Code (syntax-highlighted source), and Runs tabs without leaving the page.
- A human can open a run and see inputs, current step, events, logs, artifacts, approvals, and output.
- A human can approve or reject pending approvals in the Web Hub.
- A human can use Telegram approval notifications when configured.
- A human can create access tokens for local agents, runners, and CLI usage.

The Web Hub should feel like an internal operations console, not a marketing-first workflow builder.

### Developers and Operators

Developers and operators install, deploy, and maintain the Hub.

Expected behavior:

- Deployment is understandable from files in the repo.
- Data is stored in a predictable local directory.
- Backup is possible by copying the `data/` directory.
- Services can be inspected through systemd.
- The CLI can exercise core workflows without opening a browser.
- A runner can be started on the VPS or on another local machine with only a Hub URL and token.

### Runners

Runners are execution environments.

Expected behavior:

- A runner registers itself with the Hub.
- A runner advertises tags such as `linux`, `macos`, `node`, `git`, `shell`, `web`, and `smithers`.
- A runner polls for queued runs that match its tags.
- A runner streams events/logs back to the Hub.
- A runner uploads artifacts back to the Hub.
- A runner marks runs as succeeded or failed.
- For repository-editing workflows such as Improve, a run may select an allowlisted runner-local git repo to edit while still reporting logs and artifacts to the Hub.

The Hub remains the source of truth even when execution happens on a local machine.

## User Expectations by Surface

### Web

The Web Hub should answer:

- What capabilities exist?
- What can each capability do?
- What is running right now?
- What failed?
- What needs approval?
- What artifacts were produced?
- What runners are online?
- What agents, skills, and knowledge does the company have?

### MCP

MCP should answer:

- What can I do?
- Which capability matches this request?
- What input should I provide?
- Did the run start?
- What is its status?
- What logs or artifacts can I inspect?
- Is approval needed?

### CLI

The CLI should be useful both to humans and agents.

Expected behavior:

- It should work with a Hub URL and access token.
- It should expose the same operational concepts as MCP.
- It should be scriptable.
- It should print JSON where requested.
- It should provide install/config hints for MCP.
- It should start a foreground runner for local development or workstation use.

### API

The HTTP API is the integration layer.

Expected behavior:

- It should support internal automation.
- It should be bearer-token authenticated.
- It should expose stable resource-oriented endpoints.
- It should be documented through `/openapi.json`.

### Telegram

Telegram is an approval channel, not a separate workflow system.

Expected behavior:

- Approval requests can be pushed to a configured private operator chat, with chat/topic routing only as a legacy fallback.
- Approve/reject decisions are recorded back in the Hub.
- Web/API/CLI/MCP approval paths remain valid even when Telegram is not configured.

## Product Boundaries

Smithers Hub is not intended to replace Smithers. Smithers remains the workflow/orchestration substrate. The Hub is the company-facing capability registry, control plane, artifact store, approval inbox, and shared knowledge surface.

Smithers Hub is also not intended to be a restrictive sandbox in this version. The user explicitly expects many useful agent tasks to run in permissive mode. The product records declared permissions and runner requirements now so stricter enforcement can be added later without changing the mental model.

## Success Criteria

The product is behaving correctly when:

- A fresh deployment can be opened on the company domain.
- An access token logs a human into the Web Hub.
- Agents can discover capabilities through MCP.
- The CLI can list and run capabilities.
- A runner can execute at least one capability and upload artifacts.
- Approvals can be resolved through shared Hub channels.
- Skills, agents, and knowledge are centrally editable.
- Run history remains visible after execution is complete.
