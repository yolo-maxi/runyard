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
  deploy: z.boolean().default(true).describe("Deploy to the configured static host after gates pass."),
  publicAccess: z.boolean().default(false).describe("If true, deploy without auth. Default false.")
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
  verify: z.string()
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: ideaSchema,
  expand: expansionSchema,
  narrow: specSchema,
  build: buildSchema,
  verify: verifySchema,
  deploy: deploySchema
});

const strategist = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  cwd: PRODUCTS_ROOT,
  allowedTools: ["Read", "Grep", "Glob"],
  systemPrompt:
    "You turn raw ideas into practical product briefs. Be creative first, then ruthless about scope. Return only the requested JSON."
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
    "Do not inspect, copy, or reuse sibling product directories under the products root; they are unrelated."
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

export default smithers((ctx) => {
  const expanded = ctx.outputMaybe("expand", { nodeId: "expand" });
  const spec = ctx.outputMaybe("narrow", { nodeId: "narrow" });
  const built = ctx.outputMaybe("build", { nodeId: "build" });
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
              `Expanded context:\n${JSON.stringify(expanded, null, 2)}\n\n` +
              `Choose a short lowercase subdomain slug. Scope must fit one focused build pass. Include concrete acceptance criteria and a test plan. ` +
              `Return JSON {"appName","subdomain","productDir","oneLiner","userFlows","features","nonGoals","acceptanceCriteria","testPlan"}. ` +
              `Set productDir to "${PRODUCTS_ROOT}/<subdomain>".`}
          </Task>
        )}

        {spec && (
          <Task id="build" output={outputs.build} agent={builder} timeoutMs={60 * 60 * 1000}>
            {`Build this product in exactly this directory: ${spec.productDir || path.join(PRODUCTS_ROOT, slugify(spec.subdomain))}\n\n` +
              `SPEC:\n${JSON.stringify(spec, null, 2)}\n\n` +
              `Requirements:\n` +
              `- Use pnpm only.\n` +
              `- Start from the assigned product directory only; do not read, copy, or infer from sibling product folders.\n` +
              `- Prefer exact, stable dependency versions instead of latest/caret ranges. If using Vite/esbuild, include pnpm settings that allow required build scripts and avoid very-new transitive releases.\n` +
              `- Create a real app, not a landing placeholder.\n` +
              `- Include responsive UI, empty/error states where relevant, and polished copy.\n` +
              `- Include package.json scripts for build and at least one verification command (test or lint) when practical.\n` +
              `- Production output must be dist/, build/, or out/.\n` +
              `- Do not include credentials, .env files, source maps, databases, or node_modules in build output.\n` +
              `- Do not deploy or edit anything outside the product directory.\n` +
              `- Access mode for this run: ${ctx.input.publicAccess ? "PUBLIC/no-auth, explicitly requested" : "private magic-link auth"}.\n\n` +
              `Return JSON {"summary","filesChanged":[...],"notes"}.`}
          </Task>
        )}

        {spec && built && (
          <Task id="verify" output={outputs.verify} retries={0}>
            {async () => {
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
              if (ctx.input.deploy === false) {
                return {
                  deployed: false,
                  url: `https://${subdomain}.${PUBLIC_SUFFIX}`,
                  magicLink: ctx.input.publicAccess ? "" : `https://${subdomain}.${PUBLIC_SUFFIX}/?token=${token}`,
                  publicAccess: Boolean(ctx.input.publicAccess),
                  subdomain,
                  target,
                  verify: "deploy=false"
                };
              }
              if (REPOBOX_DEPLOY_MODE !== "local" && (!REPOBOX_HOST || !REPOBOX_SSH_KEY)) {
                throw new Error("GATE FAILED: deploy=true requires REPOBOX_HOST/STATIC_SITE_HOST and REPOBOX_SSH_KEY/STATIC_SITE_SSH_KEY on the runner, or REPOBOX_DEPLOY_MODE=local.");
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
                verify: ctx.input.publicAccess ? `public:${unauth}` : `unauth:${unauth} magic:${auth}`
              };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
