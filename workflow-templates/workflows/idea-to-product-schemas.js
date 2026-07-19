import { z } from "zod/v4";

export const ideaSchema = z.object({
  idea: z.string().describe("Raw product idea."),
  preferredSubdomain: z.string().default("").describe("Optional static-site subdomain prefix."),
  constraints: z.string().default("").describe("Optional product, design, stack, or business constraints."),
  locale: z.string().default("").describe("Optional BCP-47 locale override (e.g. en-US, it-IT). If empty, the strategist infers from the ask and falls back to en-US."),
  postRunHooks: z.array(z.string()).default([]).describe('Post-run hook profile slugs to invoke after gates pass (e.g. ["static-publish"]). Default none: build and verify only.'),
  publicAccess: z.boolean().default(false).describe("static-publish hook param: publish without auth if true. Default false."),
  replaceLive: z.boolean().default(false).describe("static-publish hook param: required to overwrite a slot that already hosts a live app. Equivalent to passing --replace-live."),
  // Deprecated: deploy=true is a legacy alias that no longer publishes - the
  // hooks task reports hook_config_required and points at postRunHooks.
  deploy: z.boolean().optional().describe("Deprecated; use postRunHooks. deploy=true does not publish anymore.")
});

export const expansionSchema = z.object({
  opportunity: z.string(),
  users: z.array(z.string()).default([]),
  productDirections: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([])
});

export const specSchema = z.object({
  appName: z.string(),
  subdomain: z.string(),
  productDir: z.string(),
  oneLiner: z.string(),
  originalAsk: z.string().default(""),
  locale: z.string().default("en-US"),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  userFlows: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([])
});

export const buildSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  notes: z.string().default("")
});

export const guardSchema = z.object({
  proceed: z.boolean(),
  target: z.string(),
  reason: z.string().default(""),
  replaceLive: z.boolean().default(false)
});

export const copySchema = z.object({
  passed: z.boolean(),
  patched: z.boolean().default(false),
  locale: z.string().default("en-US"),
  filesChanged: z.array(z.string()).default([]),
  findings: z.array(z.string()).default([]),
  notes: z.string().default("")
});

export const verifySchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.string()).default([]),
  tail: z.string().default("")
});

// Post-run hook outcomes. `status` uses the shared hook vocabulary
// (succeeded / hook_failed / hook_config_required / hook_blocked / skipped);
// a hook problem is reported here and NEVER thrown, so the build/verify run
// stays green when only the side effect misbehaved.
export const hookResultSchema = z.object({
  profile: z.string(),
  status: z.string(),
  detail: z.string().default("")
});

export const hooksSchema = z.object({
  status: z.string(),
  results: z.array(hookResultSchema).default([]),
  url: z.string().default(""),
  magicLink: z.string().default(""),
  publicAccess: z.boolean().default(false),
  subdomain: z.string().default(""),
  target: z.string().default(""),
  verify: z.string().default(""),
  publishKind: z.string().default(""),
  port: z.number().optional(),
  locale: z.string().default("en-US"),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  summary: z.string().default("")
});

export const codexStructuredOutputSchemas = {
  expand: expansionSchema,
  narrow: specSchema,
  liveAppGuard: guardSchema,
  build: buildSchema,
  copy: copySchema,
  verify: verifySchema,
  hooks: hooksSchema
};
