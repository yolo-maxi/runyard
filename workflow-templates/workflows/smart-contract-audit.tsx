// smithers-source: authored
// smithers-display-name: Smart Contract Audit
// smithers-description: Sandboxed Solidity audit. Sanitizes the target into /tmp, builds local auditor bundles, runs read-only Smithers audit agents over them, and consolidates findings into a Markdown report. Artifacts only; never writes the target.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Parallel, ClaudeCodeAgent } from "smithers-orchestrator";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";

// The local audit skill (sandbox + bundle scripts + references) must be installed on the runner.
const SKILL_DIR = process.env.AUDIT_SKILL_DIR || path.join(os.homedir(), "clawd", "skills", "audit");

const prepareSchema = z.looseObject({
  target: z.string(),
  sandbox: z.string(),
  sandboxSource: z.string(),
  bundleDir: z.string(),
  sourceFiles: z.number().default(0),
  bundles: z.array(z.object({ name: z.string(), lines: z.number() })).default([]),
  removedSensitive: z.array(z.string()).default([])
});

const findingSchema = z.looseObject({
  severity: z.string().default("info"),
  contract: z.string().default(""),
  function: z.string().default(""),
  title: z.string().default(""),
  rootCause: z.string().default(""),
  fix: z.string().default(""),
  proof: z.string().default(""),
  kind: z.enum(["FINDING", "LEAD"]).default("LEAD")
});

const auditSchema = z.looseObject({
  agent: z.string(),
  specialty: z.string().default(""),
  findings: z.array(findingSchema).default([])
});

const reportSchema = z.looseObject({
  report: z.string(),
  criticalHigh: z.number().default(0),
  requiredFixes: z.array(z.string()).default([])
});

const inputSchema = z.object({
  target: z.string().describe("Path to a repo or contracts directory to audit."),
  scope: z.string().default("").describe("Optional scope/notes for the auditors."),
  maxAgents: z.number().int().min(1).max(12).default(3).describe("How many specialist audit agents to run.")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  prepare: prepareSchema,
  audit: auditSchema,
  report: reportSchema
});

const SPECIALTIES = [
  "math-precision", "access-control", "economic-security", "execution-trace",
  "invariant", "periphery", "first-principles", "asymmetry",
  "boundary", "numerical-gap", "trust-gap", "flow-gap"
];

// Read-only auditor: reads its bundle and emits findings. Tool restrictions + a /tmp cwd keep it
// from writing anywhere; it only ever sees the sanitized sandbox paths, never the target repo.
function auditor() {
  return new ClaudeCodeAgent({
    model: "claude-sonnet-4-6",
    cwd: "/tmp",
    allowedTools: ["Read", "Grep", "Glob"],
    systemPrompt:
      "You are an isolated smart-contract security auditor. Read your assigned bundle fully before reporting. " +
      "Use only file reads/search. Never write files, run commands, use the network, or touch anything outside the bundle."
  });
}

export default smithers((ctx) => {
  const prep = ctx.outputMaybe("prepare", { nodeId: "prepare" });
  const maxAgents = Math.max(1, Math.min(ctx.input.maxAgents ?? 3, 12));
  // Contract with build-bundles.sh: only spawn one auditor per bundle it actually produced.
  // Asking for more would point an agent at a non-existent agent-<i>-bundle.md and fail the run.
  // Note: bundles.length can legitimately be 0 — treat that as "no auditors" rather than falling
  // back to maxAgents, which would spawn agents pointing at non-existent bundle files.
  const auditCount = prep ? Math.min(maxAgents, prep.bundles?.length ?? 0) : maxAgents;
  const audits = ctx.outputs.audit ?? [];

  return (
    <Workflow name="smart-contract-audit">
      <Sequence>
        {/* 1. PREPARE: deterministic sandbox + bundles via the audit skill scripts. No agent. */}
        <Task id="prepare" output={outputs.prepare} retries={0}>
          {async () => {
            const { execFileSync } = await import("node:child_process");
            const { readFileSync, existsSync } = await import("node:fs");
            const target = typeof ctx.input.target === "string" ? ctx.input.target.trim() : "";
            if (!target) {
              throw new Error("smart-contract-audit: input.target is required (got empty/null) — pass the path to a repo or contracts directory to audit.");
            }
            const sandboxSource = execFileSync(`${SKILL_DIR}/scripts/prepare-sandbox.sh`, [target], {
              encoding: "utf8",
              maxBuffer: 1024 * 1024 * 16
            }).trim();
            const sandbox = sandboxSource.replace(/\/source$/, "");
            const removedPath = `${sandbox}/removed-sensitive-files.txt`;
            const removedSensitive = existsSync(removedPath)
              ? readFileSync(removedPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
              : [];
            const bundleOut = execFileSync(`${SKILL_DIR}/scripts/build-bundles.sh`, [sandboxSource], {
              encoding: "utf8",
              maxBuffer: 1024 * 1024 * 64
            });
            const bundles = [];
            let bundleDir = "";
            let sourceFiles = 0;
            for (const line of bundleOut.split("\n")) {
              const wc = line.match(/^\s*(\d+)\s+(.*agent-\d+-bundle\.md)\s*$/);
              if (wc) bundles.push({ name: wc[2].split("/").pop(), lines: Number(wc[1]) });
              const bd = line.match(/^BUNDLE_DIR=(.*)$/);
              if (bd) bundleDir = bd[1].trim();
              const sf = line.match(/^SOURCE_FILES=(\d+)$/);
              if (sf) sourceFiles = Number(sf[1]);
            }
            if (!bundleDir) throw new Error(`build-bundles.sh produced no BUNDLE_DIR:\n${bundleOut.slice(0, 2000)}`);
            return { target, sandbox, sandboxSource, bundleDir, sourceFiles, bundles, removedSensitive };
          }}
        </Task>

        {/* 2. AUDIT: read-only specialist agents over the bundles, in parallel. */}
        {prep && (
          <Parallel maxConcurrency={Math.min(auditCount, 4)}>
            {Array.from({ length: auditCount }).map((_, i) => (
              <Task key={i} id={`audit-${i + 1}`} output={outputs.audit} agent={auditor()} timeoutMs={12 * 60 * 1000} heartbeatTimeoutMs={12 * 60 * 1000} retries={2} continueOnFail>
                {`You are audit agent ${i + 1} with the "${SPECIALTIES[i]}" specialty.\n` +
                  `Read this bundle fully — it contains the in-scope Solidity source, the senior-auditor SOP, your specialty, and shared rules:\n` +
                  `  ${prep.bundleDir}/agent-${i + 1}-bundle.md\n\n` +
                  `Additional scope notes: ${ctx.input.scope || "(none)"}\n\n` +
                  `Rules: use ONLY file reads/search. Do not write files or run commands. Trust privileged roles unless told otherwise.\n` +
                  `A FINDING needs file, function, one-sentence root cause, minimal fix, and concrete proof. Without proof, emit a LEAD.\n\n` +
                  `OUTPUT CONTRACT (HARD) — your entire response must be a single JSON object and NOTHING ELSE. ` +
                  `The first character of your response must be \`{\` and the last character must be \`}\`. ` +
                  `No prose, no preamble, no apology, no commentary before or after. ` +
                  `If you find nothing, if you cannot read the bundle, or if anything else goes wrong, you MUST still return the JSON object with an empty findings array — never reply with a plain-text status or refusal. ` +
                  `Shape (use this exact agent/specialty, replace findings with what you actually saw, or [] when none):\n` +
                  `{"agent":"${i + 1}","specialty":"${SPECIALTIES[i]}","findings":[{"severity":"high|medium|low|info","contract":"<name>","function":"<name>","title":"<short>","rootCause":"<one sentence>","fix":"<minimal patch>","proof":"<concrete evidence>","kind":"FINDING"}]}`}
              </Task>
            ))}
          </Parallel>
        )}

        {/* 3. REPORT: consolidate once the audit fan-out has settled. With continueOnFail on
            each auditor, a misbehaving agent (e.g. one that returns plain text instead of the
            declared JSON shape) no longer aborts the whole run — we still synthesise from the
            agents that did report. Also keep the legitimate zero-bundle case (auditCount === 0)
            where we render an empty report rather than skipping consolidation entirely. */}
        {prep && (auditCount === 0 || audits.length > 0) && (
          <Task id="report" output={outputs.report} agent={auditor()} timeoutMs={10 * 60 * 1000}>
            {`Consolidate these smart-contract audit results into ONE Markdown report.\n` +
              `Hard rules: deduplicate only within (contract, function) — never merge across functions; preserve distinct fixes as Option A/B. ` +
              `Lead with Critical/High loss-of-funds / unauthorized-asset-movement issues; keep Medium/Low/Info as supporting context. ` +
              `Include this AI-audit disclaimer: automated audit findings are triage, not final truth — the contract author must review disputed findings.\n\n` +
              `Context — sandbox: ${prep.sandbox}; in-scope source files: ${prep.sourceFiles}; sensitive files removed during prep: ${(prep.removedSensitive || []).length}.\n\n` +
              `Raw agent findings (JSON):\n${JSON.stringify(audits, null, 2).slice(0, 80000)}\n\n` +
              `End with a "## Required Fixes & Tests" section. ` +
              `Return JSON {"report": <the full markdown>, "criticalHigh": <count of Critical+High findings>, "requiredFixes": [<short strings>]}.`}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
