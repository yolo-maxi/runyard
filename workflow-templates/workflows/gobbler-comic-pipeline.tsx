// smithers-source: authored
// smithers-display-name: Gobbler Comic Pipeline
// smithers-description: Creates a Gloom & Gobble comic/storyboard packet from Warplet Gobbler signals, runs a mandatory copy/funniness pass, then produces exact Codex image_gen prompts for human review.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent, PiAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { createAgentFallbackPair, resolveAgentCli } from "./agent-fallback.js";

const inputSchema = z.object({
  signal: z
    .string()
    .describe("The raw content signal: gobble event, auction result, fee spike, volume spike, milestone, or 'boring day' summary."),
  sourceFacts: z
    .string()
    .default("")
    .describe("Optional grounded facts: Warplet id, traits, tx hash, reserve count, auction result, volume/fee context. Facts must be preserved."),
  warpletId: z.string().default("").describe("Optional Warplet token id for real-event episodes."),
  warpletImageUrl: z.string().default("").describe("Optional reference image URL for the Warplet/NFT visual."),
  sidequestLane: z
    .string()
    .default("auto")
    .describe("Optional lane: missing-bureau, insurance-desk, auction-gossip, evidence-board, witness-statement, city-notice, diet-review, courtroom, intern, conspiracy, or auto."),
  format: z
    .string()
    .default("auto")
    .describe("Optional format: single-panel, two-panel, three-panel, missing-poster, cctv-still, case-file, front-page, or auto."),
  styleNotes: z.string().default("").describe("Optional extra style guidance or current brand feedback."),
  avoid: z
    .string()
    .default("")
    .describe("Optional content or visual elements to avoid for this run."),
  imageCount: z.number().int().min(1).max(3).default(1).describe("How many final image prompts to prepare."),
  castCount: z.number().int().min(1).max(5).default(3).describe("How many Farcaster copy options to draft before selecting/polishing.")
});

const panelSchema = z.looseObject({
  panel: z.number().int().default(1),
  shot: z.string().default(""),
  scene: z.string().default(""),
  caption: z.string().default(""),
  visualEvidence: z.array(z.string()).default([]),
  textOnImage: z.array(z.string()).default([])
});

const storyboardSchema = z.looseObject({
  selectedLane: z.string().default(""),
  format: z.string().default(""),
  premise: z.string().default(""),
  storyHook: z.string().default(""),
  factsUsed: z.array(z.string()).default([]),
  panels: z.array(panelSchema).default([]),
  funninessHypothesis: z.string().default(""),
  visualContinuityNotes: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([])
});

const copyOptionSchema = z.looseObject({
  id: z.string().default(""),
  castText: z.string().default(""),
  imageCaption: z.string().default(""),
  whyItMightWork: z.string().default(""),
  risks: z.array(z.string()).default([])
});

const copyPassSchema = z.looseObject({
  summary: z.string().default(""),
  options: z.array(copyOptionSchema).default([]),
  selectedOptionId: z.string().default(""),
  finalCastText: z.string().default(""),
  finalImageCaption: z.string().default(""),
  punchupChanges: z.array(z.string()).default([]),
  funninessScore: z.number().min(1).max(10).default(5),
  bannedLanguageRemoved: z.array(z.string()).default([]),
  residualRisks: z.array(z.string()).default([])
});

const imagePromptSchema = z.looseObject({
  id: z.string().default(""),
  filenameHint: z.string().default(""),
  aspectRatio: z.string().default("4:5"),
  prompt: z.string().default(""),
  negativePrompt: z.string().default(""),
  textOverlay: z.array(z.string()).default([]),
  referenceInputs: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([])
});

const imagePackSchema = z.looseObject({
  summary: z.string().default(""),
  imageGenerationTool: z.string().default("Codex image_gen"),
  codexImageGenInstructions: z.string().default(""),
  prompts: z.array(imagePromptSchema).default([]),
  styleBible: z.looseObject({}).default({}),
  reviewChecklist: z.array(z.string()).default([])
});

const reviewPacketSchema = z.looseObject({
  title: z.string().default(""),
  recommendation: z.string().default(""),
  finalCastText: z.string().default(""),
  finalImageCaption: z.string().default(""),
  storyboardSummary: z.string().default(""),
  imagePromptSummary: z.string().default(""),
  reviewMarkdown: z.string().default(""),
  readyToGenerateImages: z.boolean().default(false),
  nextActions: z.array(z.string()).default([])
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  storyboard: storyboardSchema,
  copyPass: copyPassSchema,
  imagePack: imagePackSchema,
  reviewPacket: reviewPacketSchema
});

const STYLE_BIBLE = `
GLOOM & GOBBLE STYLE BIBLE
- Core format: noir detective comic / fake civic paperwork from a city where Warplets keep vanishing.
- Gobbler: black/charcoal blob body, huge nervous eyes, sharp teeth, detective/noir silhouette when useful.
- World: dark wet city, neon purple Warplet Auction House signage, paper clues, missing posters, polaroids, case files, desk lamps.
- Palette: black, charcoal, wet asphalt, neon purple, off-white paper, tiny yellow evidence-card accents.
- Typography: chunky hand-lettered comic lettering. Text must be short and readable on mobile.
- Voice: deadpan noir, over-serious bureaucracy, absurd civic ritual. The disappearance is the setting, not the punchline.
- Never use APY/ROI/trader jargon, bot gas, tx-operation logs, minOut, raw WETH accounting, or clean corporate dashboard vibes.
- Do not turn every episode into "another Warplet disappeared." Find the sidequest created by the disappearance.
`;

const SIDEQUESTS = `
SIDEQUEST LANES
- missing-bureau: bored clerk stamps another impossible case.
- insurance-desk: an adjuster refuses another "act of Gobbler" claim.
- auction-gossip: haunted auction-house staff whisper about the latest lot.
- evidence-board: a detective connects one real fact to a ridiculous theory.
- witness-statement: attendees claim they saw nothing, then reveal too much.
- city-notice: public-service poster or municipal warning.
- diet-review: the Gobbler reviews a meal with absurd seriousness.
- courtroom: the Gobbler is accused, defended, and probably judging the case.
- intern: an auction-house intern keeps updating the missing board and losing morale.
- conspiracy: a coffee stain, trait, bid, or volume spike becomes a grand theory.
`;

function createContentAgent(label: string, systemPrompt: string) {
  return createAgentFallbackPair({
    ClaudeCodeAgent,
    CodexAgent,
    PiAgent,
    primaryCli: resolveAgentCli(process.env, { workflow: "GOBBLER_COMIC", fallback: "claude" }),
    workflow: "GOBBLER_COMIC",
    label,
    cwd: process.cwd(),
    claude: {
      model: process.env.RUNYARD_GOBBLER_COMIC_CLAUDE_MODEL || "claude-sonnet-4-6",
      timeoutMs: 20 * 60 * 1000,
      dangerouslySkipPermissions: false,
      systemPrompt
    },
    codex: {
      ...(process.env.RUNYARD_GOBBLER_COMIC_CODEX_MODEL ? { model: process.env.RUNYARD_GOBBLER_COMIC_CODEX_MODEL } : {}),
      sandbox: "read-only",
      nativeStructuredOutput: true,
      systemPrompt
    }
  });
}

const storyboardAgent = createContentAgent(
  "gobbler-comic-storyboard",
  "You are the story director for Gloom & Gobble, a noir Warplet Gobbler comic series. " +
    "Create grounded, funny sidequest premises from the provided signal. Preserve stated facts, but avoid financialized framing. " +
    "Do not generate images. Return only the requested JSON."
);

const copyEditorAgent = createContentAgent(
  "gobbler-comic-copy-funniness",
  "You are the comedy editor for Gloom & Gobble. Your job is to make the copy funnier, shorter, more Farcaster-native, and less technical. " +
    "Punch up rhythm, specificity, and deadpan noir absurdity. Remove financial jargon and stale 'Warplet disappeared again' phrasing. " +
    "Do not generate images. Return only the requested JSON."
);

const imageDirectorAgent = createContentAgent(
  "gobbler-comic-image-pack",
  "You are the image director for Gloom & Gobble. You prepare exact prompts for Codex's image_gen tool and never route images through any other provider. " +
    "Your output must explicitly instruct the operator/image step to use Codex image_gen. The image prompt must preserve the approved copy and style bible. " +
    "Do not generate images in this text step. Return only the requested JSON."
);

function contextBlock(ctx: any) {
  return [
    `SIGNAL:\n${ctx.input.signal}`,
    `SOURCE FACTS:\n${ctx.input.sourceFacts || "(none provided)"}`,
    `WARPLET ID:\n${ctx.input.warpletId || "(none)"}`,
    `WARPLET IMAGE URL:\n${ctx.input.warpletImageUrl || "(none)"}`,
    `REQUESTED SIDEQUEST LANE:\n${ctx.input.sidequestLane || "auto"}`,
    `REQUESTED FORMAT:\n${ctx.input.format || "auto"}`,
    `STYLE NOTES:\n${ctx.input.styleNotes || "(none)"}`,
    `AVOID:\n${ctx.input.avoid || "(none)"}`,
    STYLE_BIBLE,
    SIDEQUESTS
  ].join("\n\n");
}

export default smithers((ctx) => {
  const storyboard = ctx.outputMaybe("storyboard", { nodeId: "storyboard" });
  const copyPass = ctx.outputMaybe("copyPass", { nodeId: "copy:funniness-pass" });
  const imagePack = ctx.outputMaybe("imagePack", { nodeId: "image:prompt-pack" });

  return (
    <Workflow name="gobbler-comic-pipeline">
      <Sequence>
        <Task id="storyboard" output={outputs.storyboard} agent={storyboardAgent} timeoutMs={20 * 60 * 1000}>
          {`Create a Gloom & Gobble storyboard from this signal.\n\n${contextBlock(ctx)}\n\n` +
            `Rules:\n` +
            `- Choose one sidequest lane; do not make the whole joke "a Warplet disappeared".\n` +
            `- Preserve any sourceFacts as facts; clearly omit facts that are not useful.\n` +
            `- Prefer 1 strong panel or 2-3 panels unless the input explicitly asks for a full page.\n` +
            `- Keep text overlays short enough to read on mobile.\n` +
            `- Include why the premise is funny before any image prompt exists.\n` +
            `Return JSON {"selectedLane","format","premise","storyHook","factsUsed","panels","funninessHypothesis","visualContinuityNotes","risks"}.`}
        </Task>

        {storyboard && (
          <Task id="copy:funniness-pass" output={outputs.copyPass} agent={copyEditorAgent} timeoutMs={20 * 60 * 1000}>
            {`Run the mandatory copy and funniness pass BEFORE image generation.\n\n${contextBlock(ctx)}\n\n` +
              `STORYBOARD:\n${JSON.stringify(storyboard, null, 2)}\n\n` +
              `Generate ${ctx.input.castCount} Farcaster copy options, then select and polish one final option.\n\n` +
              `Rules:\n` +
              `- Optimize for funniness, specificity, and shareability.\n` +
              `- Remove APY/ROI/price-pump/trader/bot-gas/raw-ops language.\n` +
              `- Do not mention every internal metric; use at most one grounded fact in public copy.\n` +
              `- Avoid repetitive "Warplet disappeared again" phrasing.\n` +
              `- Keep finalCastText short enough for Farcaster with an image.\n` +
              `Return JSON {"summary","options","selectedOptionId","finalCastText","finalImageCaption","punchupChanges","funninessScore","bannedLanguageRemoved","residualRisks"}.`}
          </Task>
        )}

        {storyboard && copyPass && (
          <Task id="image:prompt-pack" output={outputs.imagePack} agent={imageDirectorAgent} timeoutMs={20 * 60 * 1000}>
            {`Prepare the final image prompt pack. Images MUST be generated with Codex image_gen only.\n\n${contextBlock(ctx)}\n\n` +
              `STORYBOARD:\n${JSON.stringify(storyboard, null, 2)}\n\n` +
              `APPROVED/POLISHED COPY:\n${JSON.stringify(copyPass, null, 2)}\n\n` +
              `Create ${ctx.input.imageCount} prompt(s).\n\n` +
              `Rules:\n` +
              `- Do not call or recommend Midjourney, DALL-E, Ideogram, Leonardo, Stable Diffusion, or any non-Codex image provider.\n` +
              `- codexImageGenInstructions must explicitly say: use Codex image_gen with the prompt(s) below.\n` +
              `- Prompts must include the Gloom & Gobble style bible and the exact text overlays to render, if any.\n` +
              `- Text overlays must be minimal; if image text is risky, move text to finalCastText instead.\n` +
              `- Include negative prompts for generic corporate, clean dashboard, finance chart, and illegible tiny text.\n` +
              `Return JSON {"summary","imageGenerationTool":"Codex image_gen","codexImageGenInstructions","prompts","styleBible","reviewChecklist"}.`}
          </Task>
        )}

        {storyboard && copyPass && imagePack && (
          <Task id="review-packet" output={outputs.reviewPacket} agent={copyEditorAgent} timeoutMs={10 * 60 * 1000}>
            {`Assemble a concise human review packet. Do not generate images and do not post publicly.\n\n` +
              `STORYBOARD:\n${JSON.stringify(storyboard, null, 2)}\n\n` +
              `COPY:\n${JSON.stringify(copyPass, null, 2)}\n\n` +
              `IMAGE PACK:\n${JSON.stringify(imagePack, null, 2)}\n\n` +
              `Return JSON {"title","recommendation","finalCastText","finalImageCaption","storyboardSummary","imagePromptSummary","reviewMarkdown","readyToGenerateImages","nextActions"}. ` +
              `reviewMarkdown should be readable in chat with bullets, no markdown tables. nextActions should include human approval before image generation/posting.`}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
