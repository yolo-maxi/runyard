export const seedCoreCapabilities = [
  {
    slug: "run-smithers",
    name: "run-smithers (supervising wrapper)",
    description:
      "Retired supervising wrapper kept only for historical run compatibility. New RunYard workflows execute directly; do not start new runs through run-smithers.",
    category: "Retired",
    keywords: ["run-smithers", "watcher", "supervisor", "wrapper", "recovery", "lineage", "core", "smithers"],
    inputSchema: {
      type: "object",
      required: ["wrappedCapability"],
      properties: {
        wrappedCapability: {
          type: "string",
          description: "Slug of the child capability/workflow to wrap (e.g. 'implement', 'research')."
        },
        wrappedInput: {
          type: "object",
          description: "Input object forwarded to the wrapped capability. Schema depends on the wrapped capability."
        },
        goal: {
          type: "string",
          description: "Plain-language description of the outcome the watcher is trying to finish."
        },
        maxAttempts: {
          type: "number",
          description: "Max child-run attempts before requesting approval (default 8, hard ceiling)."
        },
        fingerprintThreshold: {
          type: "number",
          description: "Number of identical normalized error fingerprints before requesting approval (default 3)."
        },
        maxCodeRepairs: {
          type: "number",
          description: "Max bounded workflow-code repairs per supervised child before escalating (default 1; 0 disables self-correction)."
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", description: "succeeded | needs_recovery | abandoned" },
        wrappedRunId: { type: "string", description: "The child run id that produced the final outcome." },
        lineage: { type: "array", description: "Ordered child-run attempts the watcher recorded." },
        repairs: { type: "array", description: "Workflow-code repair attempts the watcher made (file, synced, testPassed)." },
        approval: { type: "object", description: "Approval request payload when the watcher escalated." }
      }
    },
    requiredRunnerTags: ["smithers", "vps"],
    requiredSkills: ["smithers-supervision"],
    requiredAgents: ["smithers-watcher"],
    approvalPolicy: { required: false },
    enabled: false,
    workflow: { engine: "smithers", entry: ".smithers/workflows/run-smithers.tsx" }
  },
  {
    slug: "hello",
    name: "Hello (Smithers proof)",
    description: "Minimal Smithers workflow: spawns the local Claude Code CLI and returns a structured answer. Proves real on-runner execution.",
    category: "Examples",
    keywords: ["smithers", "hello", "claude", "proof"],
    inputSchema: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string", description: "What to write a vivid sentence about." } }
    },
    outputSchema: { type: "object", properties: { answer: { type: "string" }, wordCount: { type: "number" } } },
    requiredRunnerTags: ["smithers"],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: true },
    workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" }
  },
  {
    slug: "runyard-smoke-check",
    name: "RunYard Smoke Check",
    description: "Cheap golden smoke workflow that verifies Hub to runner to Smithers output plumbing without spending model tokens.",
    category: "Operations",
    keywords: ["smoke", "health", "runner", "golden", "reliability"],
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Operator label for the smoke run." },
        expectRunner: { type: "boolean", description: "Reserved for future stricter runner checks." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        label: { type: "string" },
        checkedAt: { type: "string" },
        checks: { type: "array" },
        summary: { type: "string" }
      }
    },
    requiredRunnerTags: ["smithers"],
    requiredAgents: [],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/runyard-smoke-check.tsx" }
  },
  {
    slug: "runyard-support-agent",
    name: "Runyard Support Agent",
    description:
      "Internal in-app support chat workflow. It answers the Hub floating assistant through the subscribed on-runner CLI agent instead of requiring OpenAI or Anthropic API keys on the Hub.",
    category: "Internal",
    keywords: ["support", "chat", "assistant", "subscription", "runner", "internal"],
    inputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        system: { type: "string", description: "System prompt and current operator context prepared by the Hub." },
        messages: { type: "array", description: "Recent user/assistant chat turns." },
        context: { type: "object", description: "Current browser route/hash/page context." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        reply: { type: "string", description: "Assistant reply, optionally ending with the support action JSON block." }
      }
    },
    requiredRunnerTags: ["support"],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: true },
    workflow: { engine: "smithers", entry: ".smithers/workflows/runyard-support-agent.tsx" }
  },
  {
    slug: "research",
    name: "Research",
    description: "Smithers research workflow — the local Claude/Codex agent gathers context and returns a summary with key findings.",
    category: "Research",
    keywords: ["research", "smithers", "brief", "analysis"],
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string", description: "The research question or topic." } }
    },
    outputSchema: { type: "object", properties: { summary: { type: "string" }, keyFindings: { type: "array" } } },
    requiredRunnerTags: ["smithers"],
    requiredSkills: ["research-method"],
    requiredAgents: ["researcher"],
    approvalPolicy: { required: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/research.tsx" }
  },
  {
    slug: "implement",
    name: "Implement",
    description: "Smithers implement workflow — the local coding agent makes the change, validates, and self-reviews in a loop.",
    category: "Engineering",
    keywords: ["implement", "code", "smithers", "agent"],
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string", description: "What to implement." } }
    },
    outputSchema: { type: "object", properties: { implement: { type: "object" }, validate: { type: "object" } } },
    requiredRunnerTags: ["smithers"],
    requiredSkills: ["implementation"],
    requiredAgents: ["implementation-agent"],
    approvalPolicy: { required: true, reason: "Runs a coding agent that can modify files and run commands on the runner." },
    workflow: { engine: "smithers", entry: ".smithers/workflows/implement.tsx" }
  },
  {
    slug: "smart-contract-audit",
    name: "Smart Contract Audit",
    description:
      "Sandboxed Solidity audit: sanitizes the target into /tmp, builds local auditor bundles, runs read-only Smithers audit agents over them, and consolidates findings into a Markdown report. Artifacts only — never writes the target.",
    category: "Security",
    keywords: ["audit", "solidity", "security", "smart contract", "smithers"],
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Path to a repo or contracts directory to audit (on the runner)." },
        scope: { type: "string", description: "Optional scope/notes for the auditors." },
        maxAgents: { type: "number", description: "How many specialist audit agents to run (1-12)." }
      }
    },
    outputSchema: {
      type: "object",
      properties: { report: { type: "string" }, criticalHigh: { type: "number" }, requiredFixes: { type: "array" } }
    },
    requiredRunnerTags: ["smithers"],
    requiredSkills: ["code-review"],
    approvalPolicy: { required: false },
    // Audits fan out many agents and legitimately run long — opt out of the
    // global 30m stuck-run reaper with a 3h window.
    maxRunMinutes: 180,
    workflow: { engine: "smithers", entry: ".smithers/workflows/smart-contract-audit.tsx" }
  }
];
