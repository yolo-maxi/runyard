export const seedInternalCapabilities = [
  {
    slug: "reauth-cli",
    name: "Re-auth CLI (Codex/Claude)",
    description:
      "Re-authenticate the runner host's Codex/Claude subscription login from the Hub. Codex uses the device-code flow on the runner. Claude stores a locally generated CLAUDE_CODE_OAUTH_TOKEN sent as an encrypted one-run secret. Admin only.",
    category: "Internal",
    keywords: ["reauth", "auth", "codex", "claude", "login", "device-auth", "setup-token", "runner", "internal"],
    inputSchema: {
      type: "object",
      required: ["provider"],
      properties: {
        provider: { type: "string", enum: ["codex", "claude"], description: "Which CLI subscription login to refresh." },
        runnerTag: { type: "string", description: "Tag selecting the runner host to re-auth on." },
        oauthTokenSecretName: {
          type: "string",
          description: "Claude only: encrypted secret name carrying the pasted CLAUDE_CODE_OAUTH_TOKEN for this run."
        },
        secretNames: {
          type: "array",
          items: { type: "string" },
          description: "Secret allowlist for the runner claim payload. Used to deliver the Claude OAuth token without storing it in run input."
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        reauth: {
          type: "object",
          description: "{ status, provider, verificationUrl?, userCode?, accountId?, expiresAt? } — never any token material."
        }
      }
    },
    // Targets the dedicated re-auth-enabled runner. requiredRunnerTags must
    // match a tag that runner advertises (e.g. a `reauth` tag) so the login runs
    // on the host whose auth files we are refreshing.
    requiredRunnerTags: ["reauth"],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: true },
    // adminOnly rides in the workflow JSON so it is part of the definition hash
    // and enforced at the trigger endpoint without a schema migration. The
    // runner executes this via the REAUTH_ENABLED special path, not `smithers up`.
    workflow: { engine: "runner-native", entry: ".smithers/workflows/reauth-cli.tsx", adminOnly: true }
  }
];
