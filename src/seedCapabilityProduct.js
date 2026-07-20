export const seedProductCapabilities = [
  {
    "slug": "implement-change-gated",
    "name": "Implement Change (gated)",
    "description": "Runs an implementation agent for a change request in an isolated worktree by default, gates it, commits and pushes a Runyard branch, then waits for explicit merge-to-main promotion.",
    "category": "Engineering",
    "keywords": [
      "implement",
      "build",
      "test",
      "git",
      "gate",
      "hooks",
      "smithers"
    ],
    "inputSchema": {
      "type": "object",
      "required": [
        "workPrompt"
      ],
      "properties": {
        "workPrompt": {
          "type": "string",
          "description": "The change request / implementation prompt."
        },
        "targetBranch": {
          "type": "string",
          "description": "Branch to push (default main)."
        },
        "commitMessage": {
          "type": "string",
          "description": "Optional commit message."
        },
        "agentHarness": {
          "type": "string",
          "enum": ["claude", "codex", "pi"],
          "description": "Agent harness selected for the implementation run."
        },
        "repoDir": {
          "type": "string",
          "description": "Absolute runner-local git repo path to edit. Must be inside configured allowed improve repo roots."
        },
        "repo": {
          "type": "string",
          "description": "Optional friendly repo key resolved from the runner repo policy config."
        },
        "project": {
          "type": "string",
          "description": "Optional friendly project key resolved from the runner repo policy config."
        },
        "mutationMode": {
          "type": "string",
          "enum": [
            "parallel",
            "sequential"
          ],
          "description": "parallel creates an isolated branch/worktree and requires later promotion; sequential pushes the target branch directly."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "commit": {
          "type": "string"
        },
        "push": {
          "type": "object"
        },
        "hooks": {
          "type": "object"
        }
      }
    },
    "requiredRunnerTags": [
      "smithers"
    ],
    "requiredSkills": [
      "implementation"
    ],
    "requiredAgents": [
      "implementation-agent"
    ],
    "approvalPolicy": {
      "required": true,
      "reason": "Runs a coding agent that commits and pushes an isolated branch; merge to main is explicit."
    },
    "workflow": {
      "engine": "smithers",
      "entry": ".smithers/workflows/implement-change-gated.tsx"
    }
  },
  {
    "slug": "idea-to-product",
    "name": "Idea to Product",
    "description": "Turns a raw product idea into a scoped MVP spec, builds it with an implementation agent, runs a copywriter/localization pass, and verifies the basics (including mobile-first checks at 360px). The core run produces verified build output; publishing is an explicit post-run hook (postRunHooks: [\"static-publish\"]) that guards the live-app slot and returns the URL plus a Locale / In scope / Out of scope summary. Private by default; public access is explicit.",
    "category": "Product",
    "keywords": [
      "idea",
      "product",
      "mvp",
      "build",
      "test",
      "hooks",
      "static-publish",
      "static-site",
      "smithers",
      "locale",
      "copywriter",
      "localization"
    ],
    "inputSchema": {
      "type": "object",
      "required": [
        "idea"
      ],
      "properties": {
        "idea": {
          "type": "string",
          "description": "The raw product idea."
        },
        "preferredSubdomain": {
          "type": "string",
          "description": "Optional preferred static-site subdomain prefix."
        },
        "constraints": {
          "type": "string",
          "description": "Optional product, design, stack, or business constraints."
        },
        "locale": {
          "type": "string",
          "description": "Optional BCP-47 locale override (e.g. en-US, it-IT). Strategist infers from the ask and falls back to en-US when empty."
        },
        "postRunHooks": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Post-run hook profile slugs to invoke after gates pass (e.g. [\"static-publish\"]). Default none: the run builds and verifies only. Discover eligible profiles via GET /api/hooks?workflow=idea-to-product."
        },
        "publicAccess": {
          "type": "boolean",
          "description": "static-publish hook param: publish without auth if true. Default false."
        },
        "replaceLive": {
          "type": "boolean",
          "description": "static-publish hook param: required to overwrite a STATIC_ROOT slot that already hosts a live app. Equivalent to --replace-live."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "expand": {
          "type": "object"
        },
        "narrow": {
          "type": "object"
        },
        "liveAppGuard": {
          "type": "object"
        },
        "build": {
          "type": "object"
        },
        "copy": {
          "type": "object"
        },
        "verify": {
          "type": "object"
        },
        "hooks": {
          "type": "object"
        }
      }
    },
    "requiredRunnerTags": [
      "smithers",
      "vps"
    ],
    "requiredSkills": [
      "spec-writing",
      "implementation"
    ],
    "requiredAgents": [
      "spec-writer",
      "implementation-agent"
    ],
    "approvalPolicy": {
      "required": true,
      "reason": "Runs coding agents; the static-publish post-run hook can publish a new static site when explicitly requested."
    },
    "workflow": {
      "engine": "smithers",
      "entry": ".smithers/workflows/idea-to-product.tsx",
      "hooks": {
        "allowedProfiles": [
          "static-publish"
        ]
      }
    }
  },
  {
    "slug": "improve",
    "name": "Improve",
    "description": "Inspects an existing feature, UI, or workflow with a taste-led Product Manager, identifies prioritized improvements, then applies them in an isolated worktree by default and waits for explicit merge-to-main promotion.",
    "category": "Product",
    "keywords": [
      "improve",
      "product",
      "manager",
      "review",
      "taste",
      "polish",
      "feature",
      "smithers"
    ],
    "inputSchema": {
      "type": "object",
      "required": [
        "target"
      ],
      "properties": {
        "target": {
          "type": "string",
          "description": "What to improve — a feature, UI, workflow slug, file path, or short description the PM should inspect."
        },
        "request": {
          "type": "string",
          "description": "Back-compat alias for target used by older Hub/UI rerun payloads."
        },
        "context": {
          "type": "string",
          "description": "Optional product context, user complaints, links, screenshots, or constraints."
        },
        "repoDir": {
          "type": "string",
          "description": "Absolute runner-local git repo path to inspect/edit. Must be inside configured allowed improve repo roots."
        },
        "repo": {
          "type": "string",
          "description": "Optional friendly repo key resolved from the runner repo policy config."
        },
        "project": {
          "type": "string",
          "description": "Optional friendly project key resolved from the runner repo policy config."
        },
        "maxImprovements": {
          "type": "number",
          "description": "Cap on improvements the PM should propose (1-6, default 3)."
        },
        "targetBranch": {
          "type": "string",
          "description": "Branch to push (default main)."
        },
        "mutationMode": {
          "type": "string",
          "enum": [
            "parallel",
            "sequential"
          ],
          "description": "parallel creates an isolated branch/worktree and requires later promotion; sequential pushes the target branch directly."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "review": {
          "type": "object"
        },
        "implement": {
          "type": "object"
        },
        "test": {
          "type": "object"
        },
        "commit": {
          "type": "object"
        },
        "push": {
          "type": "object"
        },
        "hooks": {
          "type": "object"
        }
      }
    },
    "requiredRunnerTags": [
      "smithers"
    ],
    "requiredSkills": [
      "product-review",
      "implementation"
    ],
    "requiredAgents": [
      "product-manager",
      "implementation-agent"
    ],
    "approvalPolicy": {
      "required": true,
      "reason": "Runs a Product Manager review then a coding agent that commits and pushes an isolated branch; merge to main is explicit."
    },
    "workflow": {
      "engine": "smithers",
      "entry": ".smithers/workflows/improve.tsx"
    }
  },
  {
    "slug": "product-workflow",
    "name": "Product Workflow (sequential)",
    "description": "Researches RunYard's competitive/product gaps, prioritizes compact feature proposals, and reports the gated implementation runs it would create. With execute=false it is plan-only; with execute=true it queues isolated review-branch implementation runs sequentially.",
    "category": "Product",
    "keywords": [
      "product",
      "roadmap",
      "planning",
      "research",
      "features",
      "workflow",
      "smithers"
    ],
    "inputSchema": {
      "type": "object",
      "properties": {
        "context": {
          "type": "string",
          "description": "Product context, positioning, target users, known proposals, or constraints to focus the roadmap shaping run."
        },
        "competitors": {
          "type": "string",
          "description": "Optional comma- or newline-separated list of competitors/products to map first."
        },
        "maxCompetitors": {
          "type": "number",
          "description": "Maximum competitors to map (1-12, default 5)."
        },
        "maxFeatures": {
          "type": "number",
          "description": "Maximum prioritized feature proposals to report or implement (1-8, default 3)."
        },
        "execute": {
          "type": "boolean",
          "description": "false plans and reports only; true queues gated implementation runs sequentially."
        },
        "agentHarness": {
          "type": "string",
          "enum": ["claude", "codex", "pi"],
          "description": "Agent harness used by the product run and forwarded to implementation children."
        },
        "targetBranch": {
          "type": "string",
          "description": "Promotion target branch for each isolated implementation review branch if execute=true. Defaults to main."
        },
        "repoDir": {
          "type": "string",
          "description": "Absolute runner-local git repo path to inspect/build. Must be inside configured allowed improve repo roots."
        },
        "repo": {
          "type": "string",
          "description": "Friendly repo key resolved on the runner from repo policy config. Defaults to smithers-hub for RunYard."
        },
        "project": {
          "type": "string",
          "description": "Optional friendly project key resolved from runner repo policy config."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "baseline": { "type": "object" },
        "research": { "type": "object" },
        "featureMap": { "type": "object" },
        "prioritize": { "type": "object" },
        "dispatch": {
          "type": "object",
          "description": "{executed,targetRepo,targetBranch,dispatched,artifactName,report,notes}"
        }
      }
    },
    "requiredRunnerTags": [
      "smithers"
    ],
    "requiredSkills": [
      "research-method",
      "product-review",
      "spec-writing"
    ],
    "requiredAgents": [
      "researcher",
      "product-manager"
    ],
    "approvalPolicy": {
      "required": false
    },
    "workflow": {
      "engine": "smithers",
      "entry": ".smithers/workflows/product-workflow.tsx"
    }
  }
];
