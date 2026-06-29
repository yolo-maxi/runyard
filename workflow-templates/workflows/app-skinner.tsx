// smithers-source: authored
// smithers-display-name: App Skinner
// smithers-description: Explores visual skins for an app idea, proposes a shortlist, pauses for approval, then produces a concrete skin brief.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { createAgentFallbackPair } from "./agent-fallback.js";

const inputSchema = z.object({
  appIdea: z.string().describe("Raw app, miniapp, product, or feature idea to skin."),
  productContext: z.string().default("").describe("Optional target users, tone, brand, existing UI, repo, screenshots, or constraints."),
  skinCount: z.number().int().min(2).max(6).default(4).describe("How many distinct skin concepts to propose."),
  mustInclude: z.string().default("").describe("Optional visual motifs, references, copy tone, or brand requirements to include."),
  avoid: z.string().default("").describe("Optional aesthetics, motifs, colors, references, or risks to avoid.")
});

const skinConceptSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  oneLiner: z.string(),
  visualLanguage: z.array(z.string()).default([]),
  interactionFeel: z.array(z.string()).default([]),
  typography: z.string().default(""),
  colorSystem: z.array(z.string()).default([]),
  assetDirection: z.array(z.string()).default([]),
  copyVoice: z.string().default(""),
  whyItWorks: z.string().default(""),
  risks: z.array(z.string()).default([]),
  implementationNotes: z.array(z.string()).default([])
});

const proposalSchema = z.looseObject({
  summary: z.string(),
  skins: z.array(skinConceptSchema).default([]),
  recommendation: z.string().default(""),
  approvalInstructions: z.string().default("Approve one skin by name/id, or request changes with notes.")
});

const approvalSchema = z.looseObject({
  approved: z.boolean().default(false),
  note: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null)
});

const briefSchema = z.looseObject({
  approved: z.boolean().default(false),
  selectedSkinId: z.string().default(""),
  selectedSkinName: z.string().default(""),
  briefMarkdown: z.string().default(""),
  implementationPrompt: z.string().default(""),
  designTokens: z.array(z.string()).default([]),
  assetsToCreate: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([])
});

const { Workflow, Task, Approval, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  proposal: proposalSchema,
  skinApproval: approvalSchema,
  brief: briefSchema
});

const skinner = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  primaryCli: process.env.RUNYARD_APP_SKINNER_AGENT_CLI || "claude",
  label: "app-skinner",
  cwd: process.cwd(),
  claude: {
    model: process.env.RUNYARD_APP_SKINNER_CLAUDE_MODEL || "claude-sonnet-4-6",
    dangerouslySkipPermissions: false,
    systemPrompt:
    "You are a taste-forward visual direction agent. You do not build the app. " +
    "Your job is to surface visual/brand decisions before implementation guesses them. " +
    "Create sharp, distinct skins with concrete design language, not vague mood words. " +
    "Prefer memorable, shareable, app-specific looks over generic SaaS polish. Return only the requested JSON."
  },
  codex: {
    ...(process.env.RUNYARD_APP_SKINNER_CODEX_MODEL ? { model: process.env.RUNYARD_APP_SKINNER_CODEX_MODEL } : {}),
    sandbox: "read-only"
  }
});

function approvalSummary(proposal: any) {
  const skins = Array.isArray(proposal?.skins) ? proposal.skins : [];
  const lines = skins.slice(0, 6).map((skin: any) => {
    const id = skin?.id ? `${skin.id}: ` : "";
    return `${id}${skin?.name || "Untitled"} — ${skin?.oneLiner || ""}`.trim();
  });
  return [proposal?.summary, ...lines, proposal?.recommendation ? `Recommendation: ${proposal.recommendation}` : ""]
    .filter(Boolean)
    .join("\n");
}

export default smithers((ctx) => {
  const proposal = ctx.outputMaybe("proposal", { nodeId: "proposal" });
  const approval = ctx.outputMaybe("skinApproval", { nodeId: "skin:approval" });
  const approved = approval?.approved === true;

  return (
    <Workflow name="app-skinner">
      <Sequence>
        <Task id="proposal" output={outputs.proposal} agent={skinner} timeoutMs={15 * 60 * 1000}>
          {`Create ${ctx.input.skinCount} distinct visual skin concepts for this app/product idea.\n\n` +
            `APP IDEA:\n${ctx.input.appIdea}\n\n` +
            `PRODUCT CONTEXT:\n${ctx.input.productContext || "(none provided)"}\n\n` +
            `MUST INCLUDE:\n${ctx.input.mustInclude || "(none)"}\n\n` +
            `AVOID:\n${ctx.input.avoid || "(none)"}\n\n` +
            `Rules:\n` +
            `- Do not choose only one direction. Offer meaningfully different skins.\n` +
            `- Each skin must include visual language, typography, color system, asset direction, interaction feel, copy voice, why it works, risks, and implementation notes.\n` +
            `- Call out visual asset choices explicitly: photos vs illustration vs SVG/CSS/canvas/3D/generated bitmap/etc.\n` +
            `- If a choice has copyright/safety implications, say so instead of silently defaulting.\n` +
            `- Keep the concepts concise enough for a human to approve in-chat.\n` +
            `Return JSON {"summary","skins":[...],"recommendation","approvalInstructions"}.`}
        </Task>

        {proposal && !approval && (
          <Approval
            id="skin:approval"
            output={outputs.skinApproval}
            request={{
              title: "Approve app skin direction",
              summary: approvalSummary(proposal),
              metadata: {
                appIdea: ctx.input.appIdea,
                skinCount: proposal.skins?.length ?? 0,
                recommendation: proposal.recommendation ?? "",
                skins: proposal.skins ?? []
              }
            }}
            onDeny="continue"
          />
        )}

        {proposal && approval && (
          <Task id="brief" output={outputs.brief} agent={skinner} timeoutMs={15 * 60 * 1000}>
            {approved
              ? `Turn the approved skin direction into a concrete production skin brief.\n\n` +
                `APP IDEA:\n${ctx.input.appIdea}\n\n` +
                `PROPOSED SKINS:\n${JSON.stringify(proposal.skins ?? [], null, 2)}\n\n` +
                `APPROVAL NOTE / SELECTED DIRECTION:\n${approval.note || "(approver gave no note; use the recommendation)"}\n\n` +
                `RECOMMENDATION:\n${proposal.recommendation || "(none)"}\n\n` +
                `Return JSON {"approved":true,"selectedSkinId","selectedSkinName","briefMarkdown","implementationPrompt","designTokens":[...],"assetsToCreate":[...],"risks":[...],"nextActions":[...]}. ` +
                `The implementationPrompt should be ready to hand to a coding/design agent.`
              : `The human did not approve the proposed skin directions.\n\n` +
                `APP IDEA:\n${ctx.input.appIdea}\n\n` +
                `PROPOSAL SUMMARY:\n${proposal.summary}\n\n` +
                `HUMAN NOTE:\n${approval.note || "(no note)"}\n\n` +
                `Return JSON {"approved":false,"selectedSkinId":"","selectedSkinName":"","briefMarkdown":"...","implementationPrompt":"","designTokens":[],"assetsToCreate":[],"risks":[...],"nextActions":[...]}.`}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
