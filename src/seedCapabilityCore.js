export const seedCoreCapabilities = [
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
    slug: "skillmarket-quote-sidecar",
    name: "SkillMarket Quote Sidecar",
    description: "Live test quote sidecar for SkillMarket packages. Produces a bounded price estimate through real RunYard execution.",
    category: "SkillMarket",
    keywords: ["skillmarket", "quote", "marketplace", "sidecar", "smoke"],
    inputSchema: {
      type: "object",
      required: ["packageId", "packageVersion", "inputBytes", "declaredInputHash", "requestedAt"],
      properties: {
        packageId: { type: "string" },
        packageVersion: { type: "string" },
        inputBytes: { type: "number" },
        declaredInputHash: { type: "string" },
        requestedAt: { type: "string" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        priceMinMicros: { type: "string" },
        priceMaxMicros: { type: "string" },
        assumptions: { type: "array" },
        completedAt: { type: "string" }
      }
    },
    requiredRunnerTags: ["smithers"],
    requiredAgents: [],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/skillmarket-quote-sidecar.tsx" }
  },
  {
    slug: "skillmarket-package-audit",
    name: "SkillMarket Package Audit",
    description: "Live test package audit for SkillMarket manifests. Returns marketplace compatibility checks through real RunYard execution.",
    category: "SkillMarket",
    keywords: ["skillmarket", "audit", "marketplace", "compatibility", "smoke"],
    inputSchema: {
      type: "object",
      required: ["packageId", "packageVersion", "manifestHash", "manifest"],
      properties: {
        packageId: { type: "string" },
        packageVersion: { type: "string" },
        manifestHash: { type: "string" },
        manifest: { type: "object" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        checks: { type: "array" },
        completedAt: { type: "string" }
      }
    },
    requiredRunnerTags: ["smithers"],
    requiredAgents: [],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/skillmarket-package-audit.tsx" }
  },
  {
    slug: "skillmarket-paid-run",
    name: "SkillMarket Paid Run",
    description: "Live test paid-run executor for SkillMarket packages. Produces a receiptable output hash through real RunYard execution.",
    category: "SkillMarket",
    keywords: ["skillmarket", "paid-run", "marketplace", "receipt", "smoke"],
    inputSchema: {
      type: "object",
      required: ["orderId", "packageId", "packageVersion", "quoteId", "inputHash", "maxAuthorizedSpend"],
      properties: {
        orderId: { type: "string" },
        packageId: { type: "string" },
        packageVersion: { type: "string" },
        quoteId: { type: "string" },
        inputHash: { type: "string" },
        maxAuthorizedSpend: { type: "object" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        outputHash: { type: "string" },
        completedAt: { type: "string" },
        summary: { type: "string" }
      }
    },
    requiredRunnerTags: ["smithers"],
    requiredAgents: [],
    approvalPolicy: { required: false },
    supervision: { default: false, internal: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/skillmarket-paid-run.tsx" }
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
