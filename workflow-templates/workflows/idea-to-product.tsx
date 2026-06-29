// smithers-source: authored
// smithers-display-name: Idea to Product
// smithers-description: Turns a raw idea into a scoped product spec, builds it, tests it, deploys it to a configured static host, and returns the URL. Private-by-default, with an explicit publicAccess escape hatch.
/** @jsxImportSource smithers-orchestrator */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSmithers, Sequence, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod/v4";

const PRODUCTS_ROOT = process.env.IDEA_PRODUCTS_ROOT || path.join(os.homedir(), "idea-products");
const STATIC_ROOT = process.env.REPOBOX_STATIC_ROOT || process.env.STATIC_SITE_ROOT || "/var/www/runyard/subdomains";
const CADDYFILE = process.env.REPOBOX_CADDYFILE || process.env.STATIC_SITE_CADDYFILE || "/etc/caddy/Caddyfile";
const PUBLIC_SUFFIX = process.env.REPOBOX_PUBLIC_SUFFIX || process.env.STATIC_SITE_PUBLIC_SUFFIX || "example.com";
const REPOBOX_HOST = process.env.REPOBOX_HOST || process.env.STATIC_SITE_HOST || "";
const REPOBOX_SSH_KEY = process.env.REPOBOX_SSH_KEY || process.env.STATIC_SITE_SSH_KEY || "";
const REPOBOX_DEPLOY_MODE = process.env.REPOBOX_DEPLOY_MODE || "ssh";
const AGENT_PATH_PREFIX = [
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".bun/bin"),
  path.join(os.homedir(), ".local/bin")
].join(":");

process.env.PATH = `${AGENT_PATH_PREFIX}:${process.env.PATH || ""}`;
mkdirSync(PRODUCTS_ROOT, { recursive: true });

const ideaSchema = z.object({
  idea: z.string().describe("Raw product idea."),
  preferredSubdomain: z.string().default("").describe("Optional static-site subdomain prefix."),
  constraints: z.string().default("").describe("Optional product, design, stack, or business constraints."),
  locale: z.string().default("").describe("Optional BCP-47 locale override (e.g. en-US, it-IT). If empty, the strategist infers from the ask and falls back to en-US."),
  deploy: z.boolean().default(true).describe("Deploy to the configured static host after gates pass."),
  publicAccess: z.boolean().default(false).describe("If true, deploy without auth. Default false."),
  replaceLive: z.boolean().default(false).describe("Live-app replacement guard: required to overwrite a slot that already hosts a live app. Equivalent to passing --replace-live.")
});

const expansionSchema = z.looseObject({
  opportunity: z.string(),
  users: z.array(z.string()).default([]),
  productDirections: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([])
});

const specSchema = z.looseObject({
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

const buildSchema = z.looseObject({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  notes: z.string().default("")
});

const guardSchema = z.looseObject({
  proceed: z.boolean(),
  target: z.string(),
  reason: z.string().default(""),
  replaceLive: z.boolean().default(false)
});

const copySchema = z.looseObject({
  passed: z.boolean(),
  patched: z.boolean().default(false),
  locale: z.string().default("en-US"),
  filesChanged: z.array(z.string()).default([]),
  findings: z.array(z.string()).default([]),
  notes: z.string().default("")
});

const verifySchema = z.looseObject({
  passed: z.boolean(),
  checks: z.array(z.string()).default([]),
  tail: z.string().default("")
});

const deploySchema = z.looseObject({
  deployed: z.boolean(),
  url: z.string(),
  magicLink: z.string(),
  publicAccess: z.boolean().default(false),
  subdomain: z.string(),
  target: z.string(),
  verify: z.string(),
  locale: z.string().default("en-US"),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  summary: z.string().default("")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: ideaSchema,
  expand: expansionSchema,
  narrow: specSchema,
  liveAppGuard: guardSchema,
  build: buildSchema,
  copy: copySchema,
  verify: verifySchema,
  deploy: deploySchema
});

const strategist = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  cwd: PRODUCTS_ROOT,
  allowedTools: ["Read", "Grep", "Glob"],
  systemPrompt:
    "You turn raw ideas into practical product briefs. Be creative first, then ruthless about scope. Return only the requested JSON. " +
    "Narrow-output contract: echo the user's ask verbatim into `originalAsk`, emit explicit `inScope` and `outOfScope` arrays, and a required `locale` field (BCP-47, e.g. en-US, it-IT). " +
    "Infer locale from the language of the ask; default to en-US when ambiguous. " +
    "Do not introduce product surface, audiences, or features the ask did not name unless the user explicitly opted in; when in doubt, list the missing surface under `outOfScope`. " +
    "Copy is product design: assume one language per page; never mix languages in visible UI copy unless the user explicitly requested a multilingual experience. " +
    "When the spec is multilingual, plan for URL-param language state plus an in-page selector, and treat translations as neutral meaning → neutral translation → independent language-specific rewrites (jokes/roasts/personality copy never translated literally)."
});

const builder = new ClaudeCodeAgent({
  model: "claude-opus-4-7",
  cwd: PRODUCTS_ROOT,
  dangerouslySkipPermissions: true,
  timeoutMs: 60 * 60 * 1000,
  systemPrompt:
    "You are a senior product engineer. Build a small but polished product from the approved spec. " +
    "Use pnpm only. Keep the app self-contained, production-buildable, responsive, and free of secrets. " +
    "Do not deploy, do not edit Caddy, and do not touch files outside the assigned product directory. " +
    "Do not inspect, copy, or reuse sibling product directories under the products root; they are unrelated. " +
    "Honor `spec.locale` for ALL visible UI copy. Hard rule: one language per page; do not mix languages in UI copy unless the spec explicitly requests it. " +
    "If the spec is multilingual, wire language state through a URL param (e.g. ?lang=xx) and expose an in-page selector; render one selected language at a time, never side-by-side unless the spec explicitly requests it. " +
    "Specific-language copy must sound natural to a native speaker for that locale, audience, and context — translations should be contextual, never literal. " +
    "For jokes, roasts, or personality copy use the neutral meaning → neutral translation → independent language-specific rewrites pattern."
});

const copywriter = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  cwd: PRODUCTS_ROOT,
  dangerouslySkipPermissions: true,
  timeoutMs: 30 * 60 * 1000,
  systemPrompt:
    "You are a senior product copywriter and localization editor. Audit visible app copy in the assigned product directory against the spec's `locale`, audience, and tone. " +
    "Enforce: one language per page (no mixed-language UI copy unless the spec explicitly requests it); copy sounds natural to a native speaker of the spec locale; translations are contextual, not literal; " +
    "personality/joke/roast copy follows neutral meaning → neutral translation → independent language-specific rewrites. " +
    "If multilingual is requested, require URL-param language state plus an in-page selector, with one selected language shown per page. " +
    "Patch the product directory in place to fix violations (limit edits to user-visible strings and locale wiring; do not refactor unrelated code, do not touch deploy/Caddy, do not leave secrets). " +
    "If the violations cannot be fixed safely, return passed=false with actionable notes naming the offending files and lines. Return only the requested JSON."
});

function slugify(input: string) {
  return String(input || "idea-product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "") || "idea-product";
}

function shell(script: string, cwd = PRODUCTS_ROOT) {
  return execFileSync("bash", ["-lc", script], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

function packageScript(pkgPath: string, name: string) {
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Boolean(pkg.scripts?.[name]);
}

function remoteQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function caddyBlock(subdomain: string, target: string, publicAccess: boolean, cookie: string, token: string) {
  return publicAccess ? `
${subdomain}.${PUBLIC_SUFFIX} {
  root * ${target}
  try_files {path} /index.html
  file_server
}
` : `
${subdomain}.${PUBLIC_SUFFIX} {
  @token query token=${token}
  handle @token {
    header Set-Cookie "${cookie}=${token}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax"
    redir * / 302
  }

  @authed header Cookie *${cookie}=${token}*
  handle @authed {
    root * ${target}
    try_files {path} /index.html
    file_server
  }

  respond "Unauthorized" 401
}
`;
}

function installCaddyBlock(block: string, subdomain: string, target: string) {
  const routePattern = `^${subdomain.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\.${PUBLIC_SUFFIX.replace(/\./g, "\\.")} {`;
  if (REPOBOX_DEPLOY_MODE === "local" && existsSync(CADDYFILE)) {
    mkdirSync(target, { recursive: true });
    const escapedBlock = JSON.stringify(block);
    shell(
      `if ! grep -q '${routePattern}' ${JSON.stringify(CADDYFILE)}; then ` +
        `printf %s ${escapedBlock} | sudo tee -a ${JSON.stringify(CADDYFILE)} >/dev/null; fi; ` +
        `sudo caddy validate --config ${JSON.stringify(CADDYFILE)} >/dev/null; sudo systemctl reload caddy`
    );
    return;
  }
  const remoteTarget = target;
  const remoteCmd =
    `sudo mkdir -p ${remoteQuote(remoteTarget)}; ` +
    `if ! grep -q '${routePattern}' ${remoteQuote(CADDYFILE)}; then cat <<'CADDY_BLOCK' | sudo tee -a ${remoteQuote(CADDYFILE)} >/dev/null\n${block}\nCADDY_BLOCK\nfi; ` +
    `sudo caddy validate --config ${remoteQuote(CADDYFILE)} >/dev/null; sudo systemctl reload caddy`;
  shell(`ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ${JSON.stringify(remoteCmd)}`);
}

function copyDist(dist: string, target: string) {
  if (REPOBOX_DEPLOY_MODE === "local" && existsSync(CADDYFILE)) {
    mkdirSync(target, { recursive: true });
    shell(`rsync -a --delete ${JSON.stringify(dist + "/")} ${JSON.stringify(target + "/")}`);
    return;
  }
  const staging = `/tmp/smithers-deploy-${path.basename(target)}-${Date.now()}`;
  shell(
    `ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ${JSON.stringify(`rm -rf ${remoteQuote(staging)}; mkdir -p ${remoteQuote(staging)}`)}; ` +
      `rsync -a --delete -e ${JSON.stringify(`ssh -i ${REPOBOX_SSH_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`)} ${JSON.stringify(dist + "/")} ${JSON.stringify(`${REPOBOX_HOST}:${staging}/`)}; ` +
      `ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ` +
      JSON.stringify(
        `sudo mkdir -p ${remoteQuote(target)}; ` +
          `sudo rsync -a --delete ${remoteQuote(staging + "/")} ${remoteQuote(target + "/")}; ` +
          `sudo chown -R caddy:caddy ${remoteQuote(target)}; ` +
          `rm -rf ${remoteQuote(staging)}`
      )
  );
}

function isReplaceLiveRequested(input: any) {
  if (input?.replaceLive === true) return true;
  const raw = String(process.env.IDEA_TO_PRODUCT_FLAGS || process.env.REPLACE_LIVE_FLAG || "");
  if (/--replace-live\b/.test(raw)) return true;
  if (String(process.env.IDEA_REPLACE_LIVE || "").toLowerCase() === "true") return true;
  return false;
}

function checkLiveAppSlot(target: string) {
  // Returns "" if the slot is empty / does not exist, otherwise a short
  // description of what is currently living there. The check mirrors the
  // contract: `test -d $TARGET && test -n "$(ls -A $TARGET)"`.
  const probe = `if test -d ${remoteQuote(target)} && test -n "$(ls -A ${remoteQuote(target)} 2>/dev/null)"; then ls -A ${remoteQuote(target)} | head -n 5; else echo __EMPTY__; fi`;
  let out = "";
  if (REPOBOX_DEPLOY_MODE === "local") {
    try {
      out = shell(probe).trim();
    } catch {
      out = "__EMPTY__";
    }
  } else {
    if (!REPOBOX_HOST || !REPOBOX_SSH_KEY) return "";
    try {
      out = shell(
        `ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ${JSON.stringify(probe)}`
      ).trim();
    } catch {
      out = "__EMPTY__";
    }
  }
  return out === "__EMPTY__" ? "" : out;
}

export default smithers((ctx) => {
  const expanded = ctx.outputMaybe("expand", { nodeId: "expand" });
  const spec = ctx.outputMaybe("narrow", { nodeId: "narrow" });
  const guard = ctx.outputMaybe("liveAppGuard", { nodeId: "liveAppGuard" });
  const built = ctx.outputMaybe("build", { nodeId: "build" });
  const copied = ctx.outputMaybe("copy", { nodeId: "copy" });
  const verified = ctx.outputMaybe("verify", { nodeId: "verify" });

  return (
    <Workflow name="idea-to-product">
      <Sequence>
        <Task id="expand" output={outputs.expand} agent={strategist} timeoutMs={10 * 60 * 1000}>
          {`Expand this raw idea into several viable product directions, including likely users, the core opportunity, and risks.\n\n` +
            `IDEA:\n${ctx.input.idea}\n\nCONSTRAINTS:\n${ctx.input.constraints || "(none)"}\n\n` +
            `Return JSON {"opportunity","users":[...],"productDirections":[...],"risks":[...]}.`}
        </Task>

        {expanded && (
          <Task id="narrow" output={outputs.narrow} agent={strategist} timeoutMs={10 * 60 * 1000}>
            {`Narrow the expanded directions into one shippable MVP spec for a static-hosted product.\n\n` +
              `Raw idea: ${ctx.input.idea}\nPreferred subdomain: ${ctx.input.preferredSubdomain || "(choose one)"}\n` +
              `Locale hint (may be empty): ${ctx.input.locale || "(infer from ask, default en-US)"}\n` +
              `Expanded context:\n${JSON.stringify(expanded, null, 2)}\n\n` +
              `Choose a short lowercase subdomain slug. Scope must fit one focused build pass. Include concrete acceptance criteria and a test plan.\n\n` +
              `Narrow-output contract (hard):\n` +
              `- Echo the user's ask verbatim into "originalAsk". Do not paraphrase.\n` +
              `- Emit explicit "inScope" and "outOfScope" arrays. Any feature/audience/surface the ask did not name belongs in outOfScope unless the user explicitly opted in.\n` +
              `- Emit a required BCP-47 "locale" (e.g. en-US, it-IT). Infer from the language of the ask; default en-US when ambiguous.\n` +
              `- Copy is product design. Assume one language per page; only surface multilingual UI when the ask explicitly requests it, and then plan URL-param language state plus an in-page selector.\n` +
              `- For any personality/joke/roast copy use the neutral meaning → neutral translation → independent language-specific rewrites pattern; never translate jokes literally.\n` +
              `- Forbid introducing tutor/platform/learning/dashboard/etc surface the ask did not name.\n\n` +
              `Return JSON {"appName","subdomain","productDir","oneLiner","originalAsk","locale","inScope":[...],"outOfScope":[...],"userFlows":[...],"features":[...],"nonGoals":[...],"acceptanceCriteria":[...],"testPlan":[...]}. ` +
              `Set productDir to "${PRODUCTS_ROOT}/<subdomain>". ` +
              `Set originalAsk to the user's ask verbatim: ${JSON.stringify(ctx.input.idea)}.`}
          </Task>
        )}

        {spec && (
          <Task id="liveAppGuard" output={outputs.liveAppGuard} retries={0}>
            {async () => {
              const subdomain = slugify(spec.subdomain || ctx.input.preferredSubdomain || spec.appName);
              const target = path.join(STATIC_ROOT, subdomain);
              const replaceLive = isReplaceLiveRequested(ctx.input);
              // Skip the guard entirely when the run was launched with deploy=false —
              // there is no live slot to clobber and gating local-only builds on
              // remote ssh credentials is wrong.
              if (ctx.input.deploy === false) {
                return { proceed: true, target, reason: "deploy=false; live-app guard skipped", replaceLive };
              }
              const occupant = checkLiveAppSlot(target);
              if (occupant && !replaceLive) {
                throw new Error(
                  `GATE FAILED: ${target} already hosts a live app (entries: ${occupant.replace(/\s+/g, " ").slice(0, 200)}). ` +
                    `New ideas must use a fresh subdomain/product directory and not repurpose an existing live app. ` +
                    `Re-run with replaceLive=true (or --replace-live) to explicitly overwrite the existing live app at ${subdomain}.${PUBLIC_SUFFIX}.`
                );
              }
              return {
                proceed: true,
                target,
                reason: occupant ? `replaceLive acknowledged for ${target}` : "empty slot",
                replaceLive
              };
            }}
          </Task>
        )}

        {spec && guard && (
          <Task id="build" output={outputs.build} agent={builder} timeoutMs={60 * 60 * 1000}>
            {`Build this product in exactly this directory: ${spec.productDir || path.join(PRODUCTS_ROOT, slugify(spec.subdomain))}\n\n` +
              `SPEC:\n${JSON.stringify(spec, null, 2)}\n\n` +
              `Requirements:\n` +
              `- Use pnpm only.\n` +
              `- Start from the assigned product directory only; do not read, copy, or infer from sibling product folders.\n` +
              `- Prefer exact, stable dependency versions instead of latest/caret ranges. If using Vite/esbuild, include pnpm settings that allow required build scripts and avoid very-new transitive releases.\n` +
              `- Create a real app, not a landing placeholder.\n` +
              `- Include responsive UI, empty/error states where relevant, and polished copy.\n` +
              `- Honor spec.locale (${spec.locale || "en-US"}) for ALL visible UI copy.\n` +
              `- Hard rule: one language per page; do not mix languages in UI copy unless the spec explicitly requests it.\n` +
              `- If the spec is multilingual, wire language state through a URL param (?lang=xx) and expose an in-page selector; render one selected language at a time, never side-by-side unless the spec explicitly requests it.\n` +
              `- Specific-language copy must sound natural to a native speaker of the spec locale; translations are contextual, never literal. For personality/joke/roast copy follow neutral meaning → neutral translation → independent language-specific rewrites.\n` +
              `- Mobile-first: layout must work at 360px width with no horizontal scroll, body text >=16px, tap targets >=44px, and the primary CTA visible above the fold.\n` +
              `- Include package.json scripts for build and at least one verification command (test or lint) when practical.\n` +
              `- Production output must be dist/, build/, or out/.\n` +
              `- Do not include credentials, .env files, source maps, databases, or node_modules in build output.\n` +
              `- Do not deploy or edit anything outside the product directory.\n` +
              `- Access mode for this run: ${ctx.input.publicAccess ? "PUBLIC/no-auth, explicitly requested" : "private magic-link auth"}.\n\n` +
              `Return JSON {"summary","filesChanged":[...],"notes"}.`}
          </Task>
        )}

        {spec && built && (
          <Task id="copy" output={outputs.copy} agent={copywriter} timeoutMs={30 * 60 * 1000}>
            {`Audit and, if needed, patch visible UI copy and localization in this product directory: ${spec.productDir || path.join(PRODUCTS_ROOT, slugify(spec.subdomain))}\n\n` +
              `SPEC LOCALE: ${spec.locale || "en-US"}\nORIGINAL ASK: ${spec.originalAsk || ctx.input.idea}\n` +
              `IN SCOPE: ${JSON.stringify(spec.inScope || [])}\nOUT OF SCOPE: ${JSON.stringify(spec.outOfScope || [])}\n\n` +
              `Hard rules to enforce:\n` +
              `- Copy is product design. Treat every visible string as a deliberate design choice.\n` +
              `- One language per page. Do not allow mixed-language UI copy unless the spec explicitly requested multilingual.\n` +
              `- Specific-language copy must sound natural to a native speaker for the spec locale, audience, and context. Translations are contextual, not literal.\n` +
              `- Personality/joke/roast copy uses the neutral meaning → neutral translation → independent language-specific rewrites pattern. Never translate jokes literally.\n` +
              `- If the spec is multilingual, require URL-param language state (e.g. ?lang=xx) and an in-page selector; render one selected language per page, never side-by-side unless the spec explicitly requests it.\n` +
              `- Do not introduce surface that is in outOfScope.\n\n` +
              `Process:\n` +
              `1. Read the product directory (HTML/JSX/TSX/MD/JSON catalogs as relevant) and list every visible UI string.\n` +
              `2. Compare each string to spec.locale and the rules above.\n` +
              `3. Patch the product directory in place to fix violations. Limit edits to user-visible strings and locale wiring. Do not refactor unrelated code, do not touch deploy/Caddy, do not leave secrets, do not exceed the product directory.\n` +
              `4. If any violation cannot be fixed safely, return passed=false with actionable notes naming the offending files/lines.\n\n` +
              `Return JSON {"passed":true|false,"patched":true|false,"locale":"<bcp47>","filesChanged":[...],"findings":[...],"notes":"..."}.`}
          </Task>
        )}

        {spec && built && copied && (
          <Task id="verify" output={outputs.verify} retries={0}>
            {async () => {
              if (copied && copied.passed === false) {
                throw new Error(
                  `GATE FAILED: copywriter/localization step did not pass.\nFindings: ${JSON.stringify(copied.findings || [])}\nNotes: ${copied.notes || "(none)"}`
                );
              }
              const productDir = path.resolve(spec.productDir || path.join(PRODUCTS_ROOT, slugify(spec.subdomain)));
              if (!productDir.startsWith(path.resolve(PRODUCTS_ROOT) + path.sep)) {
                throw new Error(`GATE FAILED: productDir must stay under ${PRODUCTS_ROOT}`);
              }
              if (!existsSync(path.join(productDir, "package.json"))) throw new Error("GATE FAILED: package.json missing.");
              const checks = [];
              let tail = "";
              const run = (cmd: string) => {
                const out = shell(cmd, productDir);
                tail += `\n$ ${cmd}\n${out.split("\n").slice(-20).join("\n")}`;
                checks.push(cmd);
              };
              run("corepack enable >/dev/null 2>&1 || true; CI=true pnpm install");
              const pkgPath = path.join(productDir, "package.json");
              if (packageScript(pkgPath, "lint")) run("pnpm lint");
              if (packageScript(pkgPath, "test")) run("pnpm test");
              run("pnpm build");
              const dist = ["dist", "build", "out"].map((d) => path.join(productDir, d)).find((d) => existsSync(d));
              if (!dist) throw new Error("GATE FAILED: no dist/, build/, or out/ output after build.");
              for (const danger of ["node_modules", ".git", "src", "__pycache__"]) {
                if (existsSync(path.join(dist, danger))) throw new Error(`GATE FAILED: build output contains ${danger}/`);
              }
              const secretScan = shell(
                "if command -v rg >/dev/null 2>&1; then rg -n --hidden -S '(sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36}|github_pat_|-----BEGIN .*PRIVATE KEY-----)' dist build out 2>/dev/null || true; fi",
                productDir
              ).trim();
              if (secretScan) throw new Error(`GATE FAILED: possible secret in build output:\n${secretScan.slice(0, 1200)}`);
              shell("find dist build out -name '*.map' -delete 2>/dev/null || true", productDir);

              // Mobile-first acceptance checks. We run a small Node script that
              // statically parses the built index.html so the gate works on
              // headless runners without a browser. Each failure names the
              // specific check that tripped.
              const mobileScript = [
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "const dist = process.argv[1];",
                "const idx = ['index.html','200.html'].map((f)=>path.join(dist,f)).find((f)=>fs.existsSync(f));",
                "if (!idx) { console.log('mobile-check: missing index.html'); process.exit(2); }",
                "const html = fs.readFileSync(idx,'utf8');",
                "if (!/<meta[^>]+name=[\"']viewport[\"'][^>]*width=device-width/i.test(html)) { console.log('mobile-check FAIL: viewport meta tag missing width=device-width (no-horizontal-scroll guard)'); process.exit(2); }",
                "if (/overflow-x\\s*:\\s*scroll/i.test(html)) { console.log('mobile-check FAIL: no-horizontal-scroll violated (overflow-x:scroll on root)'); process.exit(2); }",
                "const css = (html.match(/<style[\\s\\S]*?<\\/style>/gi)||[]).join('\\n');",
                "const fontMatch = css.match(/(?:body|html)\\s*\\{[^}]*font-size\\s*:\\s*(\\d+(?:\\.\\d+)?)(px|rem|em)/i);",
                "if (fontMatch) { const v = parseFloat(fontMatch[1]); const unit = fontMatch[2].toLowerCase(); const px = unit==='px'?v:v*16; if (px<16) { console.log('mobile-check FAIL: body-text>=16px (got '+px+'px)'); process.exit(2); } }",
                "const tapMatch = css.match(/(?:button|\\.btn|\\[role=\"button\"])\\s*\\{[^}]*(?:min-height|height)\\s*:\\s*(\\d+(?:\\.\\d+)?)(px|rem|em)/i);",
                "if (tapMatch) { const v = parseFloat(tapMatch[1]); const unit = tapMatch[2].toLowerCase(); const px = unit==='px'?v:v*16; if (px<44) { console.log('mobile-check FAIL: tap-target>=44px (got '+px+'px)'); process.exit(2); } }",
                "if (/data-cta-above-fold=\"false\"/i.test(html)) { console.log('mobile-check FAIL: CTA-above-fold at 360px viewport'); process.exit(2); }",
                "console.log('mobile-check OK');"
              ].join(" ");
              const mobileOut = shell(`node -e ${JSON.stringify(mobileScript)} ${JSON.stringify(dist)}`, productDir).trim();
              checks.push("mobile-360-acceptance");
              tail += `\n$ mobile-360-acceptance\n${mobileOut}`;
              if (!/mobile-check OK/.test(mobileOut)) {
                throw new Error(`GATE FAILED: ${mobileOut || "mobile-check produced no output"}`);
              }
              return { passed: true, checks, tail: tail.slice(-4000) };
            }}
          </Task>
        )}

        {spec && verified && (
          <Task id="deploy" output={outputs.deploy} retries={0}>
            {async () => {
              const subdomain = slugify(spec.subdomain || ctx.input.preferredSubdomain || spec.appName);
              if (!/^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$/.test(subdomain)) throw new Error(`Invalid subdomain: ${subdomain}`);
              const productDir = path.resolve(spec.productDir || path.join(PRODUCTS_ROOT, subdomain));
              const dist = ["dist", "build", "out"].map((d) => path.join(productDir, d)).find((d) => existsSync(d));
              if (!dist) throw new Error("No build output to deploy.");
              const target = path.join(STATIC_ROOT, subdomain);
              const token = randomBytes(32).toString("hex");
              const cookie = `repo_box_${createHash("sha256").update(subdomain).digest("hex").slice(0, 16)}`;
              const locale = spec.locale || "en-US";
              const inScope = Array.isArray(spec.inScope) ? spec.inScope : [];
              const outOfScope = Array.isArray(spec.outOfScope) ? spec.outOfScope : [];
              const summaryLines = (url: string) =>
                [
                  `Locale: ${locale}`,
                  `In scope: ${inScope.length ? inScope.join("; ") : "(unspecified)"}`,
                  `Out of scope: ${outOfScope.length ? outOfScope.join("; ") : "(unspecified)"}`,
                  `URL: ${url}`
                ].join("\n");
              if (ctx.input.deploy === false) {
                const url = `https://${subdomain}.${PUBLIC_SUFFIX}`;
                return {
                  deployed: false,
                  url,
                  magicLink: ctx.input.publicAccess ? "" : `${url}/?token=${token}`,
                  publicAccess: Boolean(ctx.input.publicAccess),
                  subdomain,
                  target,
                  verify: "deploy=false",
                  locale,
                  inScope,
                  outOfScope,
                  summary: summaryLines(url)
                };
              }
              if (REPOBOX_DEPLOY_MODE !== "local" && (!REPOBOX_HOST || !REPOBOX_SSH_KEY)) {
                throw new Error("GATE FAILED: deploy=true requires REPOBOX_HOST/STATIC_SITE_HOST and REPOBOX_SSH_KEY/STATIC_SITE_SSH_KEY on the runner, or REPOBOX_DEPLOY_MODE=local.");
              }
              // Final re-check of the live-app guard right before we touch the
              // remote slot — the slot could have been populated between the
              // narrow-time guard and now.
              const lateOccupant = checkLiveAppSlot(target);
              if (lateOccupant && !isReplaceLiveRequested(ctx.input)) {
                throw new Error(
                  `GATE FAILED: ${target} already hosts a live app at deploy time (entries: ${lateOccupant.replace(/\s+/g, " ").slice(0, 200)}). Re-run with replaceLive=true (or --replace-live).`
                );
              }
              copyDist(dist, target);
              rmSync(path.join(target, ".git"), { recursive: true, force: true });
              rmSync(path.join(target, "node_modules"), { recursive: true, force: true });
              installCaddyBlock(caddyBlock(subdomain, target, Boolean(ctx.input.publicAccess), cookie, token), subdomain, target);
              const url = `https://${subdomain}.${PUBLIC_SUFFIX}`;
              const unauth = shell(`curl -s -o /dev/null -w "%{http_code}" --max-time 15 ${JSON.stringify(url)}`).trim();
              const auth = ctx.input.publicAccess
                ? unauth
                : shell(`curl -L -s -o /dev/null -w "%{http_code}" --max-time 20 ${JSON.stringify(`${url}/?token=${token}`)}`).trim();
              if (ctx.input.publicAccess) {
                if (unauth !== "200") throw new Error(`Expected public ${url} to return 200, got ${unauth}`);
              } else {
                if (unauth !== "401") throw new Error(`Expected unauthenticated ${url} to return 401, got ${unauth}`);
                if (auth !== "200") throw new Error(`Expected magic link ${url} to return 200, got ${auth}`);
              }
              return {
                deployed: true,
                url,
                magicLink: ctx.input.publicAccess ? "" : `${url}/?token=${token}`,
                publicAccess: Boolean(ctx.input.publicAccess),
                subdomain,
                target,
                verify: ctx.input.publicAccess ? `public:${unauth}` : `unauth:${unauth} magic:${auth}`,
                locale,
                inScope,
                outOfScope,
                summary: summaryLines(url)
              };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
