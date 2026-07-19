// smithers-source: authored
// smithers-display-name: Idea to Product
// smithers-description: Turns a raw idea into a scoped product spec, builds it, tests it, and verifies it. Publishing to the configured static or server-backed host is an explicit post-run hook (postRunHooks: ["static-publish"]) that returns the URL. Private-by-default, with an explicit publicAccess escape hatch.
/** @jsxImportSource smithers-orchestrator */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent, PiAgent } from "smithers-orchestrator";
import { createAgentFallbackPair, resolveAgentCli } from "./agent-fallback.js";
import {
  buildSchema,
  copySchema,
  expansionSchema,
  guardSchema,
  hooksSchema,
  ideaSchema,
  specSchema,
  verifySchema
} from "./idea-to-product-schemas.js";

const PRODUCTS_ROOT = process.env.IDEA_PRODUCTS_ROOT || path.join(os.homedir(), "idea-products");
const STATIC_ROOT = process.env.REPOBOX_STATIC_ROOT || process.env.STATIC_SITE_ROOT || "/var/www/runyard/subdomains";
const CADDYFILE = process.env.REPOBOX_CADDYFILE || process.env.STATIC_SITE_CADDYFILE || "/etc/caddy/Caddyfile";
const PUBLIC_SUFFIX = process.env.REPOBOX_PUBLIC_SUFFIX || process.env.STATIC_SITE_PUBLIC_SUFFIX || "example.com";
const REPOBOX_HOST = process.env.REPOBOX_HOST || process.env.STATIC_SITE_HOST || "";
const REPOBOX_SSH_KEY = process.env.REPOBOX_SSH_KEY || process.env.STATIC_SITE_SSH_KEY || "";
const REPOBOX_DEPLOY_MODE = process.env.REPOBOX_DEPLOY_MODE || "ssh";
const SERVICE_ROOT = process.env.REPOBOX_SERVICE_ROOT || process.env.STATIC_SERVICE_ROOT || "/home/fran/services";
const SERVICE_ENV_ROOT = process.env.REPOBOX_SERVICE_ENV_ROOT || process.env.STATIC_SERVICE_ENV_ROOT || "/home/fran/.config";
const SERVICE_USER = process.env.REPOBOX_SERVICE_USER || "fran";
const SERVICE_PORT_START = Number(process.env.REPOBOX_SERVICE_PORT_START || 3018);
const SERVICE_PORT_END = Number(process.env.REPOBOX_SERVICE_PORT_END || 3099);
const AGENT_PATH_PREFIX = [
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".bun/bin"),
  path.join(os.homedir(), ".local/bin")
].join(":");

process.env.PATH = `${AGENT_PATH_PREFIX}:${process.env.PATH || ""}`;
mkdirSync(PRODUCTS_ROOT, { recursive: true });

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: ideaSchema,
  expand: expansionSchema,
  narrow: specSchema,
  liveAppGuard: guardSchema,
  build: buildSchema,
  copy: copySchema,
  verify: verifySchema,
  hooks: hooksSchema
});

const strategist = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli: resolveAgentCli(process.env, { workflow: "IDEA", fallback: "claude" }),
  workflow: "IDEA",
  label: "idea-to-product-strategist",
  cwd: PRODUCTS_ROOT,
  claude: {
    model: process.env.RUNYARD_IDEA_STRATEGIST_CLAUDE_MODEL || "claude-sonnet-4-6",
    allowedTools: ["Read", "Grep", "Glob"],
    systemPrompt:
    "You turn raw ideas into practical product briefs. Be creative first, then ruthless about scope. Return only the requested JSON. " +
    "Narrow-output contract: echo the user's ask verbatim into `originalAsk`, emit explicit `inScope` and `outOfScope` arrays, and a required `locale` field (BCP-47, e.g. en-US, it-IT). " +
    "Infer locale from the language of the ask; default to en-US when ambiguous. " +
    "Do not introduce product surface, audiences, or features the ask did not name unless the user explicitly opted in; when in doubt, list the missing surface under `outOfScope`. " +
    "Copy is product design: assume one language per page; never mix languages in visible UI copy unless the user explicitly requested a multilingual experience. " +
    "When the spec is multilingual, plan for URL-param language state plus an in-page selector, and treat translations as neutral meaning → neutral translation → independent language-specific rewrites (jokes/roasts/personality copy never translated literally)."
  },
  codex: {
    ...(process.env.RUNYARD_IDEA_STRATEGIST_CODEX_MODEL ? { model: process.env.RUNYARD_IDEA_STRATEGIST_CODEX_MODEL } : {}),
    sandbox: "read-only"
  }
});

const builder = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli: resolveAgentCli(process.env, { workflow: "IDEA", fallback: "claude" }),
  workflow: "IDEA",
  label: "idea-to-product-builder",
  cwd: PRODUCTS_ROOT,
  claude: {
    model: process.env.RUNYARD_IDEA_BUILDER_CLAUDE_MODEL || "claude-opus-4-7",
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
  },
  codex: {
    ...(process.env.RUNYARD_IDEA_BUILDER_CODEX_MODEL ? { model: process.env.RUNYARD_IDEA_BUILDER_CODEX_MODEL } : {}),
    sandbox: "danger-full-access"
  }
});

const copywriter = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli: resolveAgentCli(process.env, { workflow: "IDEA", fallback: "claude" }),
  workflow: "IDEA",
  label: "idea-to-product-copywriter",
  cwd: PRODUCTS_ROOT,
  claude: {
    model: process.env.RUNYARD_IDEA_COPYWRITER_CLAUDE_MODEL || "claude-sonnet-4-6",
    dangerouslySkipPermissions: true,
    timeoutMs: 30 * 60 * 1000,
    systemPrompt:
    "You are a senior product copywriter and localization editor. Audit visible app copy in the assigned product directory against the spec's `locale`, audience, and tone. " +
    "Enforce: one language per page (no mixed-language UI copy unless the spec explicitly requests it); copy sounds natural to a native speaker of the spec locale; translations are contextual, not literal; " +
    "personality/joke/roast copy follows neutral meaning → neutral translation → independent language-specific rewrites. " +
    "If multilingual is requested, require URL-param language state plus an in-page selector, with one selected language shown per page. " +
    "Patch the product directory in place to fix violations (limit edits to user-visible strings and locale wiring; do not refactor unrelated code, do not touch deploy/Caddy, do not leave secrets). " +
    "If the violations cannot be fixed safely, return passed=false with actionable notes naming the offending files and lines. " +
    "Your final response must be one raw JSON object only, with no Markdown, no prose, and no code fence. Shape: " +
    "{\"passed\":true|false,\"patched\":true|false,\"locale\":\"en-US\",\"filesChanged\":[],\"findings\":[],\"notes\":\"...\"}."
  },
  codex: {
    ...(process.env.RUNYARD_IDEA_COPYWRITER_CODEX_MODEL ? { model: process.env.RUNYARD_IDEA_COPYWRITER_CODEX_MODEL } : {}),
    sandbox: "danger-full-access"
  }
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

function productUsesApi(productDir: string, dist: string) {
  const pkgPath = path.join(productDir, "package.json");
  if (packageScript(pkgPath, "start")) return true;
  if (existsSync(path.join(productDir, "server", "index.mjs"))) return true;
  try {
    const out = shell(
      "if command -v rg >/dev/null 2>&1; then rg -n -S '(/api/|fetch\\([\"'\"'`]/api|process\\.env\\.)' dist build out server package.json 2>/dev/null || true; fi",
      productDir
    ).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

function sourceEnvNames(productDir: string) {
  let out = "";
  try {
    out = shell(
      "if command -v rg >/dev/null 2>&1; then rg -o -N 'process\\.env\\.[A-Z0-9_]{2,}' server src package.json 2>/dev/null || true; fi",
      productDir
    );
  } catch {
    out = "";
  }
  const names = new Set<string>();
  for (const match of out.matchAll(/process\.env\.([A-Z0-9_]{2,})/g)) names.add(match[1]);
  return [...names].filter((name) => /^[A-Z0-9_]+$/.test(name));
}

function remoteFreeServicePort() {
  const script =
    `for p in $(seq ${Number(SERVICE_PORT_START)} ${Number(SERVICE_PORT_END)}); do ` +
    `if ! ss -ltn | awk '{print $4}' | grep -Eq "[:.]$p$"; then echo "$p"; exit 0; fi; ` +
    `done; echo "no free port in ${SERVICE_PORT_START}-${SERVICE_PORT_END}" >&2; exit 2`;
  const out = shell(`ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ${JSON.stringify(script)}`).trim();
  const port = Number(out.split(/\s+/)[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`GATE FAILED: could not allocate remote service port (${out})`);
  return port;
}

function serviceCaddyBlock(subdomain: string, port: number, publicAccess: boolean, cookie: string, token: string) {
  return publicAccess ? `
${subdomain}.${PUBLIC_SUFFIX} {
  reverse_proxy 127.0.0.1:${port}
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
    reverse_proxy 127.0.0.1:${port}
  }

  respond "Unauthorized" 401
}
`;
}

function installServiceCaddyBlock(block: string, subdomain: string) {
  const routePattern = `^${subdomain.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\.${PUBLIC_SUFFIX.replace(/\./g, "\\.")} {`;
  const marker = `runyard-managed:${subdomain}.${PUBLIC_SUFFIX}`;
  const markedBlock = `# ${marker}\n${block}\n# /${marker}\n`;
  const remoteCmd =
    `if grep -q '^# ${marker}$' ${remoteQuote(CADDYFILE)}; then ` +
    `sudo awk 'BEGIN{skip=0} /^# ${marker}$/ {skip=1; next} /^# \\/${marker}$/ {skip=0; next} !skip {print}' ${remoteQuote(CADDYFILE)} | sudo tee ${remoteQuote(CADDYFILE)}.tmp >/dev/null; ` +
    `sudo mv ${remoteQuote(CADDYFILE)}.tmp ${remoteQuote(CADDYFILE)}; ` +
    `elif grep -q '${routePattern}' ${remoteQuote(CADDYFILE)}; then ` +
    `echo 'GATE FAILED: ${subdomain}.${PUBLIC_SUFFIX} already has an unmanaged Caddy route; choose a fresh subdomain or remove/mark the route explicitly.' >&2; exit 2; fi; ` +
    `cat <<'CADDY_BLOCK' | sudo tee -a ${remoteQuote(CADDYFILE)} >/dev/null\n${markedBlock}\nCADDY_BLOCK\n` +
    `sudo caddy validate --config ${remoteQuote(CADDYFILE)} >/dev/null; sudo systemctl reload caddy`;
  shell(`ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ${JSON.stringify(remoteCmd)}`);
}

function deployServerBackedProduct(productDir: string, dist: string, subdomain: string, token: string, cookie: string, publicAccess: boolean) {
  if (REPOBOX_DEPLOY_MODE === "local") {
    throw new Error("GATE FAILED: server-backed idea products require REPOBOX_DEPLOY_MODE=ssh so the workflow can install a service and Caddy proxy.");
  }
  if (!REPOBOX_HOST || !REPOBOX_SSH_KEY) {
    throw new Error("GATE FAILED: server-backed deploy requires REPOBOX_HOST/STATIC_SITE_HOST and REPOBOX_SSH_KEY/STATIC_SITE_SSH_KEY.");
  }
  const serverEntry = path.join(productDir, "server", "index.mjs");
  if (!existsSync(serverEntry)) {
    throw new Error("GATE FAILED: product uses /api or server runtime but does not provide server/index.mjs for service deployment.");
  }

  const port = remoteFreeServicePort();
  const serviceName = slugify(subdomain);
  const remoteDir = path.posix.join(SERVICE_ROOT, serviceName);
  const remoteEnv = path.posix.join(SERVICE_ENV_ROOT, `${serviceName}.env`);
  const localTmp = path.join(os.tmpdir(), `idea-product-${serviceName}-${Date.now()}`);
  mkdirSync(localTmp, { recursive: true });
  const bundle = path.join(localTmp, "bundle.tar.gz");
  const envFile = path.join(localTmp, "service.env");
  const distDirName = path.basename(dist);
  const env: Record<string, string> = {
    PORT: String(port),
    HOST: "127.0.0.1"
  };
  for (const name of sourceEnvNames(productDir)) {
    if (process.env[name] && !/^(PATH|HOME|PWD|SHELL|USER|LOGNAME|NODE_OPTIONS)$/.test(name)) env[name] = String(process.env[name]);
  }
  writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${String(value).replace(/\n/g, "")}`).join("\n") + "\n", { mode: 0o600 });
  shell(
    `tar -C ${JSON.stringify(productDir)} ` +
      `--exclude=node_modules --exclude=.git --exclude=src --exclude=tests --exclude='*.map' --exclude='.env*' ` +
      `-czf ${JSON.stringify(bundle)} ${JSON.stringify(distDirName)} server package.json`
  );
  shell(
    `ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ` +
      JSON.stringify(`mkdir -p ${remoteQuote(remoteDir)} ${remoteQuote(SERVICE_ENV_ROOT)}`) +
      `; scp -i ${JSON.stringify(REPOBOX_SSH_KEY)} -q ${JSON.stringify(bundle)} ${JSON.stringify(`${REPOBOX_HOST}:/tmp/${serviceName}.tar.gz`)}` +
      `; scp -i ${JSON.stringify(REPOBOX_SSH_KEY)} -q ${JSON.stringify(envFile)} ${JSON.stringify(`${REPOBOX_HOST}:/tmp/${serviceName}.env`)}` +
      `; ssh -i ${JSON.stringify(REPOBOX_SSH_KEY)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${JSON.stringify(REPOBOX_HOST)} ` +
      JSON.stringify(
        `set -e; ` +
          `rm -rf ${remoteQuote(remoteDir)}/*; tar -xzf ${remoteQuote(`/tmp/${serviceName}.tar.gz`)} -C ${remoteQuote(remoteDir)}; ` +
          `mv ${remoteQuote(`/tmp/${serviceName}.env`)} ${remoteQuote(remoteEnv)}; chmod 600 ${remoteQuote(remoteEnv)}; rm -f ${remoteQuote(`/tmp/${serviceName}.tar.gz`)}; ` +
          `cat <<'UNIT' | sudo tee ${remoteQuote(`/etc/systemd/system/${serviceName}.service`)} >/dev/null\n` +
          `[Unit]\nDescription=Idea product ${serviceName}\nAfter=network.target\n\n` +
          `[Service]\nType=simple\nUser=${SERVICE_USER}\nWorkingDirectory=${remoteDir}\nEnvironmentFile=${remoteEnv}\nExecStart=/bin/bash -lc 'if command -v bun >/dev/null 2>&1; then exec bun server/index.mjs; elif [ -x /home/${SERVICE_USER}/.bun/bin/bun ]; then exec /home/${SERVICE_USER}/.bun/bin/bun server/index.mjs; else exec node server/index.mjs; fi'\nRestart=always\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=false\n\n[Install]\nWantedBy=multi-user.target\nUNIT\n` +
          `sudo systemctl daemon-reload; sudo systemctl enable --now ${remoteQuote(`${serviceName}.service`)}; sudo systemctl restart ${remoteQuote(`${serviceName}.service`)}; ` +
          `sleep 1; sudo systemctl is-active --quiet ${remoteQuote(`${serviceName}.service`)}; curl -fsS --max-time 10 ${remoteQuote(`http://127.0.0.1:${port}/api/health`)} >/dev/null || true`
      )
  );
  rmSync(localTmp, { recursive: true, force: true });
  installServiceCaddyBlock(serviceCaddyBlock(subdomain, port, publicAccess, cookie, token), subdomain);
  return { target: remoteDir, port };
}

const STATIC_PUBLISH_HOOK = "static-publish";

function requestedHooks(input: any): string[] {
  return Array.isArray(input?.postRunHooks)
    ? input.postRunHooks.map((slug: any) => String(slug || "").trim()).filter(Boolean)
    : [];
}

function staticPublishRequested(input: any) {
  return requestedHooks(input).includes(STATIC_PUBLISH_HOOK);
}

// Legacy deploy=true without an explicit hook selection: deprecated. It never
// publishes — the hooks task reports hook_config_required instead.
function legacyDeployRequested(input: any) {
  return input?.deploy === true && !staticPublishRequested(input);
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
              // Skip the guard entirely when no static-publish hook was
              // requested — there is no live slot to clobber and gating
              // local-only builds on remote ssh credentials is wrong.
              if (!staticPublishRequested(ctx.input)) {
                return { proceed: true, target, reason: "no static-publish hook requested; live-app guard skipped", replaceLive };
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
              `- If the product needs server-side API calls, secrets, TTS, LLMs, payments, or any /api route, include a zero-dependency Node/Bun-compatible server at server/index.mjs that serves the built app and exposes the API. Keep secrets in process.env and never in browser code.\n` +
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
              `Return exactly one raw JSON object and nothing else. Do not include Markdown, prose, or a code fence.\n` +
              `Required shape: {"passed":true|false,"patched":true|false,"locale":"<bcp47>","filesChanged":[...],"findings":[...],"notes":"..."}.`}
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

        {/* Post-run hooks: explicit, opt-in side effects after the verify
            gate. Hook problems are reported as per-hook statuses
            (hook_failed / hook_config_required / hook_blocked) and never
            thrown — a broken publish must not turn a verified build into a
            failed run. */}
        {spec && verified && (
          <Task id="hooks" output={outputs.hooks} retries={0}>
            {async () => {
              const subdomain = slugify(spec.subdomain || ctx.input.preferredSubdomain || spec.appName);
              const productDir = path.resolve(spec.productDir || path.join(PRODUCTS_ROOT, subdomain));
              const dist = ["dist", "build", "out"].map((d) => path.join(productDir, d)).find((d) => existsSync(d));
              const target = path.join(STATIC_ROOT, subdomain);
              const token = randomBytes(32).toString("hex");
              const cookie = `repo_box_${createHash("sha256").update(subdomain).digest("hex").slice(0, 16)}`;
              const serverBacked = dist ? productUsesApi(productDir, dist) : false;
              const locale = spec.locale || "en-US";
              const inScope = Array.isArray(spec.inScope) ? spec.inScope : [];
              const outOfScope = Array.isArray(spec.outOfScope) ? spec.outOfScope : [];
              const url = `https://${subdomain}.${PUBLIC_SUFFIX}`;
              const summaryLines = [
                `Locale: ${locale}`,
                `In scope: ${inScope.length ? inScope.join("; ") : "(unspecified)"}`,
                `Out of scope: ${outOfScope.length ? outOfScope.join("; ") : "(unspecified)"}`,
                `URL: ${url}`
              ].join("\n");
              const base = {
                url: "",
                magicLink: "",
                publicAccess: Boolean(ctx.input.publicAccess),
                subdomain,
                target,
                verify: "",
                publishKind: serverBacked ? "service" : "static",
                locale,
                inScope,
                outOfScope,
                summary: summaryLines
              };

              const hooks = requestedHooks(ctx.input);
              const results: any[] = [];
              // Severity order shared with the Hub (src/hookOutcomes.js).
              const aggregate = () => {
                const precedence = ["hook_failed", "hook_config_required", "hook_blocked", "succeeded", "skipped"];
                return precedence.find((status) => results.some((r) => r.status === status)) || "skipped";
              };

              if (legacyDeployRequested(ctx.input)) {
                results.push({
                  profile: "legacy:deploy",
                  status: "hook_config_required",
                  detail: 'deploy=true is deprecated and no longer publishes. Pass postRunHooks: ["static-publish"] (requires an admin-enabled static-publish hook profile; see runyard hooks).'
                });
              }
              for (const profile of hooks) {
                if (profile !== STATIC_PUBLISH_HOOK) {
                  results.push({
                    profile,
                    status: "hook_blocked",
                    detail: "This workflow only supports the static-publish hook profile in this release."
                  });
                }
              }

              if (!staticPublishRequested(ctx.input)) {
                return {
                  ...base,
                  status: aggregate(),
                  results,
                  verify: results.length ? results.map((r) => `${r.profile}: ${r.status}`).join("; ") : ""
                };
              }

              // --- static-publish hook -----------------------------------
              const publish = async () => {
                if (!/^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$/.test(subdomain)) {
                  return { status: "hook_failed", detail: `Invalid subdomain: ${subdomain}` };
                }
                if (!dist) return { status: "hook_failed", detail: "No build output to publish." };
                if (REPOBOX_DEPLOY_MODE !== "local" && (!REPOBOX_HOST || !REPOBOX_SSH_KEY)) {
                  return {
                    status: "hook_config_required",
                    detail: "static-publish requires REPOBOX_HOST/STATIC_SITE_HOST and REPOBOX_SSH_KEY/STATIC_SITE_SSH_KEY on the runner, or REPOBOX_DEPLOY_MODE=local."
                  };
                }
                // Final re-check of the live-app guard right before we touch
                // the remote slot — it could have been populated between the
                // narrow-time guard and now.
                const lateOccupant = checkLiveAppSlot(target);
                if (lateOccupant && !isReplaceLiveRequested(ctx.input)) {
                  return {
                    status: "hook_blocked",
                    detail: `${target} already hosts a live app at publish time (entries: ${lateOccupant.replace(/\s+/g, " ").slice(0, 200)}). Re-run with replaceLive=true (or --replace-live).`
                  };
                }
                let finalTarget = target;
                let port: number | undefined;
                let publishKind = "static";
                if (serverBacked) {
                  const service = deployServerBackedProduct(productDir, dist, subdomain, token, cookie, Boolean(ctx.input.publicAccess));
                  finalTarget = service.target;
                  port = service.port;
                  publishKind = "service";
                } else {
                  copyDist(dist, target);
                  rmSync(path.join(target, ".git"), { recursive: true, force: true });
                  rmSync(path.join(target, "node_modules"), { recursive: true, force: true });
                  installCaddyBlock(caddyBlock(subdomain, target, Boolean(ctx.input.publicAccess), cookie, token), subdomain, target);
                }
                const unauth = shell(`curl -s -o /dev/null -w "%{http_code}" --max-time 15 ${JSON.stringify(url)}`).trim();
                const auth = ctx.input.publicAccess
                  ? unauth
                  : shell(`curl -L -s -o /dev/null -w "%{http_code}" --max-time 20 ${JSON.stringify(`${url}/?token=${token}`)}`).trim();
                if (ctx.input.publicAccess) {
                  if (unauth !== "200") return { status: "hook_failed", detail: `Expected public ${url} to return 200, got ${unauth}` };
                } else {
                  if (unauth !== "401") return { status: "hook_failed", detail: `Expected unauthenticated ${url} to return 401, got ${unauth}` };
                  if (auth !== "200") return { status: "hook_failed", detail: `Expected magic link ${url} to return 200, got ${auth}` };
                }
                return {
                  status: "succeeded",
                  detail: ctx.input.publicAccess ? `public:${unauth}` : `unauth:${unauth} magic:${auth}`,
                  finalTarget,
                  port,
                  publishKind
                };
              };

              let published: any;
              try {
                published = await publish();
              } catch (error: any) {
                published = { status: "hook_failed", detail: String(error?.message || error).slice(0, 1200) };
              }
              results.push({ profile: STATIC_PUBLISH_HOOK, status: published.status, detail: published.detail || "" });
              return {
                ...base,
                status: aggregate(),
                results,
                ...(published.status === "succeeded"
                  ? {
                      url,
                      magicLink: ctx.input.publicAccess ? "" : `${url}/?token=${token}`,
                      target: published.finalTarget,
                      publishKind: published.publishKind,
                      port: published.port
                    }
                  : {}),
                verify: published.status === "succeeded" ? "" : `static-publish: ${published.status} — ${published.detail || ""}`.slice(0, 400)
              };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
