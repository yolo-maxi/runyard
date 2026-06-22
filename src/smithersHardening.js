export const SMITHERS_SAMPLES_REFERENCE = {
  repository: "https://github.com/dennisonbertram/smithers-samples",
  sampledCommit: "7eeeccf",
  samples: [
    {
      slug: "durable-fix-until-green",
      runyardPattern: "agent edits followed by deterministic tests in a bounded retry loop"
    },
    {
      slug: "content-quality-loop",
      runyardPattern: "writer/judge/revise loops must read the latest iteration output"
    },
    {
      slug: "cost-aware-model-router",
      runyardPattern: "cheap-first model routing with verifier gates and explicit cost attribution"
    },
    {
      slug: "multi-agent-code-review",
      runyardPattern: "parallel specialist fanout, synthesis, then human approval"
    },
    {
      slug: "resilient-etl-saga",
      runyardPattern: "side-effecting delivery steps need compensation or terminal audit records"
    }
  ]
};

export const RESERVED_SMITHERS_OUTPUT_FIELDS = new Set(["nodeId", "runId", "iteration"]);
export const FRACTIONAL_SQLITE_FIELD_HINTS = [
  "score",
  "confidence",
  "cost",
  "price",
  "ratio",
  "fraction",
  "percent",
  "latencyMs"
];

export function classifySmithersProcessExit(exitCode) {
  if (exitCode === 0) {
    return { state: "succeeded", terminal: true, needsApproval: false, failed: false };
  }
  if (exitCode === 3) {
    return { state: "paused_for_approval", terminal: false, needsApproval: true, failed: false };
  }
  return { state: "failed", terminal: true, needsApproval: false, failed: true };
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function pushFinding(findings, kind, message, index, source) {
  findings.push({
    kind,
    message,
    line: lineNumberForOffset(source, index)
  });
}

export function lintSmithersWorkflowSource(source) {
  const findings = [];
  const text = String(source || "");

  for (const field of RESERVED_SMITHERS_OUTPUT_FIELDS) {
    const re = new RegExp(`\\b${field}\\s*:\\s*z\\.`, "g");
    for (const match of text.matchAll(re)) {
      pushFinding(
        findings,
        "reserved-output-field",
        `Output field "${field}" collides with Smithers internal columns; use a domain name instead.`,
        match.index || 0,
        text
      );
    }
  }

  for (const hint of FRACTIONAL_SQLITE_FIELD_HINTS) {
    const re = new RegExp(`\\b${hint}\\s*:\\s*z\\.number\\s*\\(`, "gi");
    for (const match of text.matchAll(re)) {
      pushFinding(
        findings,
        "fractional-number-field",
        `Field "${hint}" often needs fractional precision through SQLite; prefer z.string() unless it is an integer.`,
        match.index || 0,
        text
      );
    }
  }

  const loopBlocks = text.matchAll(/<Loop[\s\S]*?<\/Loop>/g);
  for (const match of loopBlocks) {
    const block = match[0];
    const blockStart = match.index || 0;
    if (/ctx\.outputMaybe\s*\(/.test(block) && !/ctx\.latest\s*\(/.test(block)) {
      pushFinding(
        findings,
        "loop-first-output",
        "Loop body reads ctx.outputMaybe without ctx.latest; this can pin exit conditions to iteration 0.",
        blockStart + block.search(/ctx\.outputMaybe\s*\(/),
        text
      );
    }
  }

  const nonAnthropicAgents = text.matchAll(/new\s+(OpenAIAgent|CodexAgent|HermesAgent)\s*\(\s*\{([\s\S]*?)\}\s*\)/g);
  for (const match of nonAnthropicAgents) {
    const body = match[2] || "";
    if (!/nativeStructuredOutput\s*:\s*true/.test(body)) {
      pushFinding(
        findings,
        "native-structured-output",
        `${match[1]} structured-output tasks should opt in with nativeStructuredOutput: true when the workflow expects pure structured rows.`,
        match.index || 0,
        text
      );
    }
  }

  if (/scorers\s*(?::|=)\s*\{/.test(text) && !/_smithers_scorers|scores\s+<|scores\s*\(/.test(text)) {
    pushFinding(
      findings,
      "scorer-storage",
      "Scorer results are not guaranteed in event NDJSON; expose/read scorer storage explicitly.",
      text.search(/scorers\s*(?::|=)\s*\{/),
      text
    );
  }

  return findings;
}
