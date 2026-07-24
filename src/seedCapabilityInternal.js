import {
  CI_HUB_TAG,
  CI_JOB_CAPABILITY_SLUG,
  CI_PIPELINE_CAPABILITY_SLUG,
  CI_RUNNER_TAG
} from "./ciCapabilities.js";

export const seedInternalCapabilities = [
  {
    // Parent run for one CI trigger (see specs/ci-platform.md). Hub-owned:
    // the runyard-hub tag is never advertised by a runner and the hub moves
    // the run queued->running at creation, so the claim path can never take it.
    slug: CI_PIPELINE_CAPABILITY_SLUG,
    name: "CI Pipeline",
    description:
      "Parent run of one CI trigger: holds provenance, job roll-up, and the GitHub Checks evidence trail. Created by the CI webhook/dispatch path, driven by the hub orchestrator — never launched manually.",
    category: "Internal",
    keywords: ["ci", "pipeline", "github", "checks", "internal"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        conclusion: { type: "string" },
        jobs: { type: "array" }
      }
    },
    requiredRunnerTags: [CI_HUB_TAG],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: true },
    workflow: { engine: "runyard-ci" }
  },
  {
    // One executable CI job. Deterministic: the runner's CI executor runs the
    // validated commands / Dagger call — no LLM, no smithers engine.
    slug: CI_JOB_CAPABILITY_SLUG,
    name: "CI Job",
    description:
      "One CI job of a pipeline, executed deterministically on a CI-enabled runner (native commands or a Dagger call) against an exact SHA-pinned checkout. Created by the CI orchestrator — never launched manually.",
    category: "Internal",
    keywords: ["ci", "job", "build", "test", "internal"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        exitCode: { type: "number" },
        conclusion: { type: "string" }
      }
    },
    requiredRunnerTags: [CI_RUNNER_TAG],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: true },
    workflow: { engine: "runyard-ci" }
  },
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
