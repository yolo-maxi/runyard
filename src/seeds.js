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
  },
  {
    slug: "taste-agent",
    name: "Taste Agent",
    description: "Explores distinct product skins and surfaces taste, tone, and asset-direction choices before implementation.",
    instructions: "Generate sharp visual directions with rationale and risks. Make aesthetic tradeoffs explicit instead of silently defaulting.",
    tools: ["files", "design-references"],
    skillSlugs: ["visual-design", "brand-strategy"]
  },
  {
    slug: "design-director",
    name: "Design Director",
    description: "Turns an approved skin into a production-ready visual brief, design tokens, asset list, and implementation prompt.",
    instructions: "Convert approved visual direction into concrete UI guidance: hierarchy, palette, type, motion, assets, copy voice, and implementation notes.",
    tools: ["files", "design-references"],
    skillSlugs: ["visual-design", "brand-strategy"]
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
  },
  {
    slug: "visual-design",
    name: "Visual Design Direction",
    description: "How agents should propose and critique visual/UI skins.",
    body: "Offer distinct, nameable directions with concrete layout, type, color, motion, asset, and interaction choices. Explain why each direction fits the product and what tradeoffs or risks it carries."
  },
  {
    slug: "brand-strategy",
    name: "Brand Strategy",
    description: "How agents should connect product intent to a memorable brand and skin.",
    body: "Tie the skin to audience, category, emotion, and shareability. Avoid generic polish. Surface copyright, cultural, safety, and asset-production implications before build."
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
  },
  {
    slug: "implement-change-gated",
    name: "Implement Change (gated)",
    description:
      "Runs an implementation agent for a change request, then gates it (pnpm test, staged diff, a sane commit, push to origin) before optionally deploying to the repo.box prod target. deploy=false stops after push and reports what would deploy.",
    category: "Engineering",
    keywords: ["implement", "build", "test", "git", "deploy", "gate", "smithers"],
    inputSchema: {
      type: "object",
      required: ["workPrompt"],
      properties: {
        workPrompt: { type: "string", description: "The change request / implementation prompt." },
        deploy: { type: "boolean", description: "Deploy to prod after gates pass (default false)." },
        targetBranch: { type: "string", description: "Branch to push (default main)." },
        commitMessage: { type: "string", description: "Optional commit message." }
      }
    },
    outputSchema: {
      type: "object",
      properties: { commit: { type: "string" }, push: { type: "object" }, deploy: { type: "object" } }
    },
    requiredRunnerTags: ["smithers"],
    requiredSkills: ["implementation"],
    requiredAgents: ["implementation-agent"],
    approvalPolicy: { required: true, reason: "Runs a coding agent that commits, pushes to origin, and can deploy to production." },
    workflow: { engine: "smithers", entry: ".smithers/workflows/implement-change-gated.tsx" }
  },
  {
    slug: "idea-to-product",
    name: "Idea to Product",
    description:
      "Turns a raw product idea into a scoped MVP spec, builds it with an implementation agent, verifies the basics, deploys it to repo.box, and returns the URL. Private by default; public access is explicit.",
    category: "Product",
    keywords: ["idea", "product", "mvp", "build", "test", "deploy", "repo.box", "smithers"],
    inputSchema: {
      type: "object",
      required: ["idea"],
      properties: {
        idea: { type: "string", description: "The raw product idea." },
        preferredSubdomain: { type: "string", description: "Optional preferred repo.box subdomain prefix." },
        constraints: { type: "string", description: "Optional product, design, stack, or business constraints." },
        deploy: { type: "boolean", description: "Deploy after gates pass (default true)." },
        publicAccess: { type: "boolean", description: "Deploy without auth if true. Default false." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        expand: { type: "object" },
        narrow: { type: "object" },
        build: { type: "object" },
        verify: { type: "object" },
        deploy: { type: "object" }
      }
    },
    requiredRunnerTags: ["smithers", "vps"],
    requiredSkills: ["spec-writing", "implementation"],
    requiredAgents: ["spec-writer", "implementation-agent"],
    approvalPolicy: {
      required: true,
      reason: "Runs coding agents and can deploy a new repo.box subdomain."
    },
    workflow: { engine: "smithers", entry: ".smithers/workflows/idea-to-product.tsx" }
  },
  {
    slug: "app-skinner",
    name: "App Skinner",
    description:
      "Explores visual skins for an app idea, proposes a shortlist, pauses for approval, then produces a concrete production skin brief for the selected direction.",
    category: "Product",
    keywords: ["skin", "visual", "brand", "design", "taste", "approval", "miniapp", "smithers"],
    inputSchema: {
      type: "object",
      required: ["appIdea"],
      properties: {
        appIdea: { type: "string", description: "Raw app, miniapp, product, or feature idea to skin." },
        productContext: { type: "string", description: "Optional users, tone, brand, screenshots, repo, or constraints." },
        skinCount: { type: "number", description: "How many distinct skin concepts to propose (2-6, default 4)." },
        mustInclude: { type: "string", description: "Optional motifs, references, copy tone, or brand requirements to include." },
        avoid: { type: "string", description: "Optional aesthetics, motifs, colors, references, or risks to avoid." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal: { type: "object" },
        skinApproval: { type: "object" },
        brief: { type: "object" }
      }
    },
    requiredRunnerTags: ["smithers", "vps"],
    requiredSkills: ["visual-design", "brand-strategy"],
    requiredAgents: ["taste-agent", "design-director"],
    approvalPolicy: {
      required: true,
      reason: "Pauses for human approval before turning a proposed visual skin into an implementation brief."
    },
    workflow: { engine: "smithers", entry: ".smithers/workflows/app-skinner.tsx" }
  }
];
