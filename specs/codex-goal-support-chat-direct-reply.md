# Goal: make Runyard support chat reply directly without visible support runs

Fran reported that the in-app support chat is currently not behaving like a chat. It shows "support run queued" / waiting status and creates visible `runyard-support-agent` runs in the normal Runs UI. That is not useful.

Implement a more reasonable support-chat path:

- When the user sends a message in the support chat, the chat should just reply as the assistant in the same chat panel.
- Do not show a persistent "support run queued" message to the user.
- Do not show support-chat executions as normal rows/cards in the main Runs UI.
- If internal execution state still exists, it must be hidden from ordinary run listings and dashboard stats by default.
- A debug/admin-only way to inspect internal support executions is acceptable, but not required for this task.

Likely context:

- Frontend: `web/components/SupportChat.jsx`
- API: `/api/chat`, `/api/chat/status` in `src/server.js`
- Existing support implementation: `src/supportWarm.js`, `src/smithers-runner.js`, `workflow-templates/workflows/runyard-support-agent.tsx`, support runner env/service behavior
- Existing tests: `tests/api.test.js`, support chat UI tests, run list/UI tests
- Brief: `/home/xiko/clawd/memory/projects/smithers-hub.md` contains the prior June 22/23 support-chat history.

Implementation guidance:

- Prefer the simplest reliable path. If Hub can call the warm support agent directly on this machine without enqueueing a normal run, do that. If it still needs a runner-backed internal execution path, make the internal run hidden from normal UI/API listings and make `/api/chat` wait/return a normal assistant reply.
- Preserve the no-API-key constraint unless there is already a configured provider; the current intended model is to use local CLI/subscription auth.
- Avoid creating more visible operational noise in Runs for every support chat turn.
- The chat can show a short transient "thinking" indicator while waiting, but not a queued-run placeholder as the response.
- Keep changes scoped to support chat behavior and run listing/stat filtering. Do not redesign unrelated Runs UI.
- Work with the current repo state. Do not revert unrelated existing dirt.

Acceptance criteria:

- Sending a support chat message returns `{ reply: ... }` through `/api/chat` and renders as an assistant message in the chat.
- No `runyard-support-agent` rows appear in the ordinary Runs list or normal dashboard stats after a support chat turn.
- Existing real workflow runs continue to appear normally.
- If support execution times out or fails, the chat shows a clear chat-local error only; the normal Runs UI is not polluted with that internal attempt.
- Add/adjust regression tests that would have failed for the current screenshot behavior.

Evaluation gates:

- Run focused support/API tests first, especially `node --experimental-sqlite --test tests/api.test.js` or narrower support-chat tests if available.
- Run UI/source tests touching `SupportChat.jsx` and Runs list filtering.
- Run `pnpm test`.
- Run `pnpm build`.
- Run `git diff --check`.
- If a live server smoke is practical, verify `/api/chat/status`, one `/api/chat` request, and the ordinary runs list behavior.

Report back with:

- Files changed.
- Tests run and results.
- Whether support chat now uses a direct path or a hidden internal execution path.
- Any deployment/restart steps needed.
