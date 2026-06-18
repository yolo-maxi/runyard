import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Optional allow-list of filesystem roots the runner may operate in.
const allowedRoots = String(process.env.SMITHERS_RUNNER_ALLOWED_ROOTS || "")
  .split(/[:,]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

let warnedNoAllowList = false;

// Reject repository paths outside the configured roots. With no roots configured we permit
// (preserving single-machine setups) but warn once, since this is arbitrary command execution.
function assertAllowedRepo(repo) {
  if (!repo) return repo;
  const resolved = path.resolve(repo);
  if (!allowedRoots.length) {
    if (!warnedNoAllowList) {
      console.warn(
        "[smithers-hub-runner] SMITHERS_RUNNER_ALLOWED_ROOTS is not set; the runner will execute work in any path. Set it to constrain execution."
      );
      warnedNoAllowList = true;
    }
    return resolved;
  }
  const ok = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(`repo path '${resolved}' is not within an allowed runner root`);
  }
  return resolved;
}

function fence(value) {
  return String(value ?? "").trim() || "_not provided_";
}

function artifact(name, content, mimeType = "text/markdown") {
  return { name, content, mimeType };
}

async function git(repo, args) {
  const result = await execFileAsync("git", args, {
    cwd: repo,
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 8
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function reviewPr(input, emit) {
  await emit("workflow.step", "Gathering repository context");
  const repo = assertAllowedRepo(input.repo);
  let status = "";
  let diff = "";
  let log = "";
  try {
    status = await git(repo, ["status", "--short"]);
    diff = await git(repo, ["diff", "--stat"]);
    log = await git(repo, ["log", "--oneline", "-n", "12"]);
  } catch (error) {
    status = `Could not inspect repo with git: ${error.message}`;
  }
  await emit("workflow.step", "Preparing review artifact");
  const markdown = `# Pull Request Review

## Scope

- Repository: ${fence(repo)}
- PR: ${fence(input.pr)}
- Focus: ${fence(input.focus || "general correctness, regressions, tests, and maintainability")}

## Findings

No automated findings were produced by the built-in runner. This artifact captures repository context for an attached review agent to continue from.

## Repository Status

\`\`\`txt
${fence(status)}
\`\`\`

## Diff Stat

\`\`\`txt
${fence(diff)}
\`\`\`

## Recent Commits

\`\`\`txt
${fence(log)}
\`\`\`

## Reviewer Instructions

Use the Code Review Rubric skill. Prioritize concrete bugs and missing high-value tests over style commentary.
`;
  return {
    output: { markdownReview: markdown, findings: [] },
    artifacts: [artifact("pull-request-review.md", markdown)]
  };
}

async function researchTopic(input, emit) {
  await emit("workflow.step", "Structuring research brief");
  const topic = fence(input.topic);
  const markdown = `# Research Brief: ${topic}

## Objective

Research ${topic} at ${fence(input.depth || "standard")} depth.

## Source Preference

${fence(input.sourcePreference || "Prefer primary sources and recent official documentation.")}

## Initial Research Plan

1. Identify primary sources and current authoritative references.
2. Separate stable background from facts that may have changed recently.
3. Collect direct links and dates for cited claims.
4. Produce a concise answer, open questions, and recommended follow-up work.

## Notes

This built-in workflow creates the durable research brief scaffold and artifact. A web-enabled agent should continue the source gathering stage from this run context.
`;
  return {
    output: { brief: markdown, sources: [] },
    artifacts: [artifact("research-brief.md", markdown)]
  };
}

async function prepareSpec(input, emit) {
  await emit("workflow.step", "Preparing implementation spec");
  const markdown = `# Implementation Spec

## Goal

${fence(input.goal)}

## Context

${fence(input.context)}

## Constraints

${fence(input.constraints)}

## Product Requirements

- Define the user-facing capability and expected outcome.
- Make the capability discoverable through MCP, CLI, API, and Web Hub.
- Persist runs, events, logs, artifacts, approvals, and final output centrally.
- Keep local execution compatible with runner-based dispatch.

## Technical Requirements

- Define input and output schemas.
- Assign required runner tags, agents, and skills.
- Specify approval policy.
- Emit structured run events for every material state change.
- Store generated files as artifacts.

## Acceptance Criteria

- Capability is visible in the catalog.
- Agent can inspect and invoke it through MCP.
- CLI can invoke and inspect the run.
- Web Hub shows run status, events, logs, artifacts, and output.
- Approval, if required, can be handled through Web/API/MCP/CLI.

## Open Questions

- Which runner should execute this by default?
- Are external credentials or repository permissions required?
- What artifacts should be retained permanently?
`;
  return {
    output: { spec: markdown, openQuestions: ["Default runner?", "Required credentials?", "Artifact retention?"] },
    artifacts: [artifact("implementation-spec.md", markdown)]
  };
}

async function implement(input, emit) {
  await emit("workflow.step", "Inspecting implementation request");
  const repo = assertAllowedRepo(input.repo);
  let gitStatus = "";
  let tests = "";
  try {
    gitStatus = await git(repo, ["status", "--short"]);
  } catch (error) {
    gitStatus = `Could not inspect repo: ${error.message}`;
  }
  if (input.testCommand) {
    await emit("workflow.step", `Running test command: ${input.testCommand}`);
    try {
      const result = await execFileAsync("bash", ["-lc", input.testCommand], {
        cwd: repo,
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 8
      });
      tests = `${result.stdout || ""}${result.stderr || ""}`.trim();
    } catch (error) {
      tests = `${error.stdout || ""}${error.stderr || ""}${error.message}`.trim();
    }
  }
  const markdown = `# Implementation Run

## Task

${fence(input.task)}

## Repository

${fence(repo)}

## Git Status

\`\`\`txt
${fence(gitStatus)}
\`\`\`

## Test Output

\`\`\`txt
${fence(tests || "No test command supplied.")}
\`\`\`

## Result

The built-in implementation runner prepared the execution record, captured repository state, and ran the requested tests. Code-editing work should be carried out by a connected coding agent using this run as the durable coordination record.
`;
  return {
    output: { summary: markdown, changedFiles: [], tests },
    artifacts: [artifact("implementation-report.md", markdown)]
  };
}

async function runSmithersWorkflow(input, emit) {
  await emit("workflow.step", "Preparing Smithers workflow handoff");
  let discovered = "";
  try {
    const result = await execFileAsync("bash", ["-lc", "command -v smithers || true; command -v bun || true"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    discovered = result.stdout.trim();
  } catch (error) {
    discovered = error.message;
  }
  const markdown = `# Smithers Workflow Run

## Workflow

${fence(input.workflow)}

## Payload

\`\`\`json
${JSON.stringify(input.payload || {}, null, 2)}
\`\`\`

## Runtime Discovery

\`\`\`txt
${fence(discovered)}
\`\`\`

## Notes

This Hub runner records and archives Smithers workflow execution requests. Configure a concrete Smithers command in the capability workflow definition to execute a specific workflow directly.
`;
  return {
    output: { result: { workflow: input.workflow, payload: input.payload || {} } },
    artifacts: [artifact("smithers-workflow-request.md", markdown)]
  };
}

export async function executeBuiltinWorkflow(capability, input, emit) {
  const name = capability.workflow?.name || capability.slug;
  if (name === "review-pr") return reviewPr(input, emit);
  if (name === "research-topic") return researchTopic(input, emit);
  if (name === "prepare-spec") return prepareSpec(input, emit);
  if (name === "implement") return implement(input, emit);
  if (name === "run-smithers-workflow") return runSmithersWorkflow(input, emit);
  throw new Error(`No built-in workflow registered for ${name}`);
}

export function writeLocalArtifacts(runId, artifacts) {
  const dir = path.join(os.tmpdir(), "smithers-hub-runner", runId);
  mkdirSync(dir, { recursive: true });
  return artifacts.map((item) => {
    const filePath = path.join(dir, item.name.replace(/[/\\]/g, "-"));
    writeFileSync(filePath, item.content);
    const stats = statSync(filePath);
    return {
      name: item.name,
      mimeType: item.mimeType || "application/octet-stream",
      sizeBytes: stats.size,
      contentBase64: readFileSync(filePath).toString("base64")
    };
  });
}
