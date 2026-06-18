export const seedAgents = [
  {
    slug: "pr-reviewer",
    name: "PR Reviewer",
    description: "Reviews code changes for correctness, regressions, test gaps, and maintainability.",
    instructions: "Prioritize concrete bugs and risks. Report file and line references where available. Keep summaries secondary to findings.",
    tools: ["git", "github", "shell", "tests"],
    skillSlugs: ["code-review"]
  },
  {
    slug: "researcher",
    name: "Researcher",
    description: "Builds sourced research briefs for agents and humans.",
    instructions: "Gather current evidence, separate facts from inference, cite sources, and end with open questions.",
    tools: ["web", "files"],
    skillSlugs: ["research-method"]
  },
  {
    slug: "spec-writer",
    name: "Spec Writer",
    description: "Turns ambiguous goals into implementation-ready specs.",
    instructions: "Define objects, interfaces, acceptance criteria, non-goals, rollout risks, and verification steps.",
    tools: ["files", "web"],
    skillSlugs: ["spec-writing"]
  },
  {
    slug: "implementation-agent",
    name: "Implementation Agent",
    description: "Implements approved specs in a repo and reports tests, changes, and residual risks.",
    instructions: "Inspect the existing codebase first, keep edits scoped, run tests, and preserve unrelated user changes.",
    tools: ["git", "shell", "tests", "files"],
    skillSlugs: ["implementation"]
  }
];

export const seedSkills = [
  {
    slug: "code-review",
    name: "Code Review Rubric",
    description: "Shared review expectations for pull requests and patches.",
    body: "Lead with correctness, security, data-loss, deployment, and regression risks. Include missing tests only when they protect real behavior. Avoid style-only comments unless they block maintainability."
  },
  {
    slug: "research-method",
    name: "Research Method",
    description: "How company agents should perform research.",
    body: "Prefer primary sources, record publication dates, cite links, mark uncertainty, and distinguish direct evidence from inference. For current facts, verify rather than relying on memory."
  },
  {
    slug: "spec-writing",
    name: "Spec Writing",
    description: "Spec format for implementation-ready product and technical plans.",
    body: "Describe the product objective, user flows, data model, APIs, interfaces, acceptance criteria, test plan, deployment plan, non-goals, and known risks."
  },
  {
    slug: "implementation",
    name: "Implementation Discipline",
    description: "Company implementation standards for local and remote coding agents.",
    body: "Read the codebase before changing it. Prefer existing patterns. Keep scope aligned with the requested outcome. Verify with tests and runtime checks. Never overwrite unrelated work."
  }
];

export const seedKnowledge = [
  {
    slug: "smithers-hub-mental-model",
    title: "Smithers Hub Mental Model",
    type: "doc",
    body: "Agents consume capabilities. Capabilities are backed by workflows, agents, skills, and knowledge. Runners execute locally or remotely. The Hub records runs, logs, artifacts, and approvals centrally.",
    tags: ["hub", "architecture", "agents"]
  }
];

// Capabilities ARE Smithers workflows. `workflow.entry` is the workflow file (relative to a
// runner's .smithers workspace); the runner executes `smithers up <entry>` so the local
// Claude Code / Codex CLI does the real work and the Hub records events, traces, and outputs.
export const seedCapabilities = [
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
    workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" }
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
    workflow: { engine: "smithers", entry: ".smithers/workflows/smart-contract-audit.tsx" }
  }
];
