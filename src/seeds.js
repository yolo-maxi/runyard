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

export const seedCapabilities = [
  {
    slug: "review-pr",
    name: "Review Pull Request",
    description: "Review a GitHub pull request or local repo diff and produce structured findings.",
    category: "Engineering",
    keywords: ["github", "review", "pull request", "code"],
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        repo: { type: "string", description: "Repository URL or local path visible to the selected runner." },
        pr: { type: "string", description: "PR URL/number, or omit to review current diff." },
        focus: { type: "string", description: "Review focus such as security, tests, or regressions." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        markdownReview: { type: "string" },
        findings: { type: "array" },
        artifacts: { type: "array" }
      }
    },
    requiredRunnerTags: ["git"],
    requiredSkills: ["code-review"],
    requiredAgents: ["pr-reviewer"],
    approvalPolicy: { required: false },
    workflow: { type: "builtin", name: "review-pr" }
  },
  {
    slug: "research-topic",
    name: "Research Topic",
    description: "Research a topic and produce a cited brief with open questions and next actions.",
    category: "Research",
    keywords: ["research", "brief", "sources", "analysis"],
    inputSchema: {
      type: "object",
      required: ["topic"],
      properties: {
        topic: { type: "string" },
        depth: { type: "string", enum: ["quick", "standard", "deep"] },
        sourcePreference: { type: "string" }
      }
    },
    outputSchema: { type: "object", properties: { brief: { type: "string" }, sources: { type: "array" } } },
    requiredRunnerTags: ["web"],
    requiredSkills: ["research-method"],
    requiredAgents: ["researcher"],
    approvalPolicy: { required: false },
    workflow: { type: "builtin", name: "research-topic" }
  },
  {
    slug: "prepare-spec",
    name: "Prepare Spec",
    description: "Turn a goal or brief into an implementation-ready product and technical spec.",
    category: "Planning",
    keywords: ["spec", "plan", "requirements", "acceptance criteria"],
    inputSchema: {
      type: "object",
      required: ["goal"],
      properties: {
        goal: { type: "string" },
        context: { type: "string" },
        constraints: { type: "string" }
      }
    },
    outputSchema: { type: "object", properties: { spec: { type: "string" }, openQuestions: { type: "array" } } },
    requiredRunnerTags: ["node"],
    requiredSkills: ["spec-writing"],
    requiredAgents: ["spec-writer"],
    approvalPolicy: { required: false },
    workflow: { type: "builtin", name: "prepare-spec" }
  },
  {
    slug: "implement",
    name: "Implement",
    description: "Implement a requested change in a repository, run tests, and return a patch summary.",
    category: "Engineering",
    keywords: ["implement", "code", "tests", "patch"],
    inputSchema: {
      type: "object",
      required: ["repo", "task"],
      properties: {
        repo: { type: "string", description: "Local path on the runner." },
        task: { type: "string" },
        testCommand: { type: "string" }
      }
    },
    outputSchema: { type: "object", properties: { summary: { type: "string" }, changedFiles: { type: "array" }, tests: { type: "string" } } },
    requiredRunnerTags: ["git", "shell"],
    requiredSkills: ["implementation"],
    requiredAgents: ["implementation-agent"],
    approvalPolicy: { required: true, reason: "Implementation may modify local repositories or run commands." },
    workflow: { type: "builtin", name: "implement" }
  },
  {
    slug: "run-smithers-workflow",
    name: "Run Smithers Workflow",
    description: "Run an existing Smithers workflow by ID or path and archive its logs and artifacts in the Hub.",
    category: "Smithers",
    keywords: ["smithers", "workflow", "orchestration", "runner"],
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: { type: "string", description: "Smithers workflow name, path, or package reference." },
        payload: { type: "object" }
      }
    },
    outputSchema: { type: "object", properties: { result: { type: "object" }, artifacts: { type: "array" } } },
    requiredRunnerTags: ["smithers"],
    requiredSkills: ["implementation"],
    requiredAgents: ["implementation-agent"],
    approvalPolicy: { required: false },
    workflow: { type: "builtin", name: "run-smithers-workflow" }
  }
];
