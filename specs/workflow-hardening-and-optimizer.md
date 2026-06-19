# Workflow Hardening and Optimizer

Runyard should not only run agent workflows. It should improve them until repeated parts become deterministic software.

The guiding process order is:

1. Question requirements.
2. Delete unnecessary steps.
3. Simplify and optimize.
4. Accelerate cycle time.
5. Automate.

In Runyard, "automate" does not mean replacing humans with agents. It means replacing agent judgment with machine-checkable scripts, code, and tests when a step has become repeatable.

## Product Thesis

Agents are excellent at discovering process. They inspect a repo, try commands, write shell scripts, debug failures, and learn which checks matter.

That knowledge should not stay buried in transcripts. Runyard should capture it, extract it, and harden it into workflow infrastructure.

The desired gradient is:

- Raw agentic work.
- Constrained agentic work with explicit input/output contracts.
- Checkpointed agentic work with recovery policy.
- Script-backed work where agents handle exceptions.
- Deterministic code with tests.
- Automated machine steps with anomaly escalation.

Creative judgment, taste, prioritization, and ambiguous product calls may remain agentic. Engineering plumbing, setup, verification, deployment, routing, parsing, and artifact handling should harden aggressively.

## Hardening Levels

### L0: Raw Agentic

The step is mostly a prompt. Inputs and outputs may be loosely described. Variance is expected.

Use when:

- The problem is new.
- The output shape is not known.
- Human taste or exploration matters.

### L1: Constrained Agentic

The step has explicit input and output contracts, but an agent still decides how to satisfy them.

Required metadata:

- Purpose.
- Required inputs.
- Expected outputs.
- Acceptance checks.
- Known failure modes.

### L2: Checkpointed Agentic

The step writes enough state for recovery.

Required metadata:

- Last successful checkpoint.
- Recovery command or recovery prompt.
- Error fingerprint.
- Retry count for the same fingerprint.
- Conditions that require approval.

### L3: Script-Backed

The common path is a script or command sequence. An agent supervises exceptions and edits the script only when the process changes.

Required metadata:

- Script path.
- Arguments.
- Expected files.
- Test command.
- Owner workflow step.

### L4: Deterministic Code

The step is implemented as code with tests and a typed contract.

Required metadata:

- Code entrypoint.
- Input schema.
- Output schema.
- Unit/integration tests.
- Upgrade procedure.

### L5: Automated Machine Step

The step runs without an agent in normal operation. An agent or human is only invoked for anomaly handling.

Required metadata:

- Anomaly detector.
- Alert target.
- Rollback or compensation path.
- Human approval policy, if required.

## Optimizer Loop

The nightly optimizer should act like a process-improvement worker, not a generic "make it better" agent.

It should:

1. Pick representative workflows and fixtures.
2. Re-run them in isolated run workspaces.
3. Diff outputs, artifacts, timing, and failure modes.
4. Identify high-variance, high-cost, high-failure, or high-token steps.
5. Ask whether the step can be deleted.
6. If not deleted, ask whether it can be split smaller.
7. If stable, extract scripts or commands from the run trace.
8. If script-backed, propose code with tests.
9. Open a Runyard improvement run or PR with evidence.
10. Re-run workflow fixtures to prove the simplified path still works.

The optimizer should prefer deletion and simplification over adding more agents.

## Script Extraction

Agents often create useful local scripts while working. Runyard should treat those scripts as process discoveries.

Examples:

- A shell snippet that verifies deploy prerequisites.
- A Node script that parses Smithers events.
- A Playwright check that confirms a canvas is nonblank.
- A static-site audit command.
- A package setup command sequence.

The optimizer should extract these into durable workflow assets when they recur.

Extraction criteria:

- The same command pattern appears in multiple successful runs.
- The output is easy to verify.
- Failure modes are known.
- The step can be run without broad agent discretion.
- The script can be tested against fixtures.

## Atomicity and Recovery

Hardening must support the Runyard reliability model:

- Draft work may exist inside isolated run workspaces.
- Promotion is atomic: commit, publish, deploy, or mark-live only happens after final checks.
- If a workflow fails after useful checkpoints, status becomes `needs_recovery`, not generic `failed`.
- Recovery runs link back to the original run.
- Manual/Ocean recovery must also create Hub lineage.

This avoids abandoned half-finished artifacts while preserving useful work.

## Step Metadata

Every workflow step should eventually expose:

- `purpose`
- `hardeningLevel`
- `requirementOwner`
- `inputSchema`
- `outputSchema`
- `acceptanceChecks`
- `checkpointPath`
- `scriptPath`
- `tests`
- `varianceScore`
- `failureRate`
- `averageDurationMs`
- `averageTokenCost`
- `approvalPolicy`
- `knownFailureModes`
- `nextHardeningCandidate`

The Web UI should show this on workflow graphs so operators can see which parts are still agentic and which parts have compiled into code.

## Product Implications

Runyard should become a workflow compiler:

- Start with agentic workflows.
- Observe repeated behavior.
- Extract repeatable process.
- Delete unnecessary steps.
- Harden stable pieces into scripts and code.
- Keep agents where ambiguity, taste, or approval is valuable.

The platform should make this progression visible and measurable.
