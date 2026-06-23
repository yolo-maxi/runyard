// smithers-source: authored
// smithers-display-name: Re-auth CLI (Codex/Claude)
// smithers-description: Re-authenticate the runner host's Codex/Claude subscription login from the Hub. Admin only.
/** @jsxImportSource smithers-orchestrator */
//
// This capability is executed by a dedicated runner-side special path (see
// src/reauthCli.js, gated by REAUTH_ENABLED=1), NOT by running this workflow:
// the runner drives `codex login --device-auth` / `claude setup-token` on its
// own host, streams the verification URL + user code back as run output, and
// writes the auth file on success. This file exists so the capability is a
// real, inspectable Smithers workflow (seeded + `smithers workflow inspect`),
// and the Task below is only the inert fallback if it is ever launched on a
// runner without the special path enabled.
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

const reauthOutput = z.looseObject({
  status: z.string(),
  provider: z.string().optional(),
  verificationUrl: z.string().optional(),
  userCode: z.string().optional(),
  accountId: z.string().optional(),
  expiresAt: z.string().optional(),
});

const inputSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  runnerTag: z.string().optional(),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  reauth: reauthOutput,
});

export default smithers((ctx) => (
  <Workflow name="reauth-cli">
    <Task id="reauth" output={reauthOutput} agent={providers.claude}>
      {`Re-auth for provider "${ctx.input.provider}" must run via the runner's REAUTH_ENABLED special path. ` +
        `This workflow body is an inert fallback. Return JSON ` +
        `{"status":"not_executed","provider":"${ctx.input.provider}"}.`}
    </Task>
  </Workflow>
));
