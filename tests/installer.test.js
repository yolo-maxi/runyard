import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const install = read("../install.sh");
const updateScript = read("../scripts/runyard-update.sh");
const workflow = read("../.github/workflows/release.yml");
const cli = read("../src/cli.js");
const updatectl = read("../src/updatectl.js");

describe("install.sh — defensiveness + idempotency", () => {
  it("uses strict bash mode", () => {
    assert.match(install, /^#!\/usr\/bin\/env bash/);
    assert.match(install, /set -euo pipefail/);
  });

  it("does not clobber an existing env file, data dir, or SECRETS_ENC_KEY", () => {
    assert.match(install, /if \[ -f "\$hub_env" \]; then\s*\n\s*log "keeping existing/);
    assert.match(install, /mkdir -p "\$DATA_DIR"/);
    // The key is only generated on the fresh-write branch (inside the else).
    assert.match(install, /enc_key="\$\(gen_key\)"/);
  });

  it("never prints the generated key/secret values to stdout/logs", () => {
    // The risk is echoing the VALUE variables; mentioning the key NAME in a log
    // line is fine. The value only ever lands inside the env-file heredoc (tee).
    assert.doesNotMatch(install, /(echo|printf)\b[^\n]*\$enc_key/);
    assert.doesNotMatch(install, /(echo|printf)\b[^\n]*\$session_secret/);
    assert.match(install, /SECRETS_ENC_KEY=\$enc_key/);
    assert.match(install, /umask 077/); // env file created 0600 from the start
    assert.match(install, /chmod 600 "\$hub_env"/);
  });

  it("generates a SECRETS_ENC_KEY (openssl or node crypto) and a session secret", () => {
    assert.match(install, /openssl rand -base64 32/);
    assert.match(install, /randomBytes\(32\)/);
    assert.match(install, /RUNYARD_HUB_SESSION_SECRET=\$session_secret/);
  });

  it("installs the pinned runner agent CLIs (codex/claude/smithers), gated + non-fatal", () => {
    // The runner shells out to these; a fresh host without them is the
    // "no codex on the machine" failure. Pinned for reproducibility.
    assert.match(install, /@openai\/codex@\$\{RUNYARD_CODEX_VERSION:-[\d.]+\}/);
    assert.match(install, /@anthropic-ai\/claude-code@\$\{RUNYARD_CLAUDE_VERSION:-[\d.]+\}/);
    assert.match(install, /smithers-orchestrator@\$\{RUNYARD_SMITHERS_VERSION:-[\d.]+\}/);
    // Only on a runner host, and OPT-IN by default (off) so a headless
    // `curl | bash` install can't stall on a forced global CLI install.
    assert.match(install, /install_agent_clis\(\)/);
    assert.match(install, /\[ "\$INSTALL_RUNNER" = "1" \] \|\| return 0/);
    assert.match(install, /INSTALL_AGENTS="\$\{RUNYARD_INSTALL_AGENTS:-0\}"/);
    assert.match(install, /if \[ "\$INSTALL_AGENTS" != "1" \]; then/);
    // Non-fatal: warns rather than die on missing npm / failed install.
    assert.doesNotMatch(install, /die "agent CLI/);
    // Wired into main() right after deps, and reminds the operator to log in.
    assert.match(install, /install_deps\s*\n\s*install_agent_clis/);
    assert.match(install, /codex login/);
    assert.match(install, /claude setup-token/);
  });

  it("ensures node 22 + pnpm", () => {
    assert.match(install, /node_major" -lt 22/);
    assert.match(install, /setup_22\.x/);
    assert.match(install, /corepack|npm install -g pnpm/);
  });

  it("reuses deploy/*.service for the units", () => {
    assert.match(install, /deploy\/runyard\.service/);
    assert.match(install, /deploy\/runyard-runner\.service/);
    assert.match(install, /systemctl enable --now runyard\.service/);
  });

  it("points hub and runner at the SAME data dir so the drain flag is shared", () => {
    const hubData = install.match(/RUNYARD_HUB_DATA_DIR=\$DATA_DIR/g) || [];
    assert.ok(hubData.length >= 2, "both hub and runner env files set RUNYARD_HUB_DATA_DIR=$DATA_DIR");
  });

  it("installs a passive update-CHECK timer only — never auto-apply", () => {
    assert.match(install, /updatectl\.js check/);
    assert.match(install, /runyard-update-check\.timer/);
    // The timer/installer must NOT wire the apply orchestrator to run automatically.
    assert.doesNotMatch(install, /Timer[\s\S]*runyard-update\.sh/);
    assert.doesNotMatch(install, /ExecStart=[^\n]*runyard-update\.sh/);
  });

  it("prints Caddy as instructions and does NOT install/manage Caddy", () => {
    assert.match(install, /reverse_proxy 127\.0\.0\.1/);
    // No package-manager install or service management of caddy (prose is fine).
    assert.doesNotMatch(install, /(apt-get|yum|dnf|brew|npm)[^\n]*install[^\n]*caddy/i);
    assert.doesNotMatch(install, /systemctl[^\n]*caddy/i);
  });

  it("is privilege-aware (root or sudo)", () => {
    assert.match(install, /\(id -u\)" -ne 0/);
    assert.match(install, /SUDO="sudo"/);
  });
});

describe("updatectl.js — the shell's DB/logic bridge (check is passive)", () => {
  it("exposes the subcommands the orchestrator calls", () => {
    for (const cmd of ["drain", "clear-drain", "record-last-good", "last-good", "alert", "check"]) {
      assert.match(updatectl, new RegExp(`case "${cmd}"`), `missing subcommand: ${cmd}`);
    }
  });

  it("the passive check never shells out to git or systemctl", () => {
    // updatectl must not perform the dangerous operations itself; those live in
    // the shell. (No child_process import at all.)
    assert.doesNotMatch(updatectl, /child_process/);
  });
});

describe("CI release workflow", () => {
  it("runs pnpm test on PRs and pushes to main", () => {
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /pnpm test/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.match(workflow, /node-version: 22/);
  });

  it("only publishes a release for v* tags AFTER tests pass", () => {
    assert.match(workflow, /tags: \["v\*"\]/);
    assert.match(workflow, /needs: test/);
    assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    assert.match(workflow, /action-gh-release/);
    // The release job must depend on test, so a red run can't publish.
    const releaseIdx = workflow.indexOf("release:");
    const needsIdx = workflow.indexOf("needs: test");
    assert.ok(needsIdx > releaseIdx, "release job declares needs: test");
  });
});

describe("HTTP apply launcher (cgroup survival)", () => {
  const server = read("../src/server.js");
  it("prefers a transient systemd-run unit so the updater survives the hub restart", () => {
    // A child left in the hub's own cgroup would be killed by `systemctl restart
    // runyard`. The apply path must launch into its own cgroup when possible.
    assert.match(server, /systemd-run/);
    assert.match(server, /--collect/);
    assert.match(server, /detached: true/);
  });
  it("admin apply is gated behind UPDATE_APPLY_ENABLED with a safe 503 default", () => {
    assert.match(server, /if \(!env\.updateApplyEnabled\)/);
    assert.match(server, /requireScopes\("admin"\)[\s\S]{0,80}update\/apply|update\/apply[\s\S]{0,200}requireScopes\("admin"\)/);
  });
});

describe("CLI `runyard update` wiring", () => {
  it("registers an operator-initiated update subcommand that runs the local script", () => {
    assert.match(cli, /\.command\("update \[tag\]"\)/);
    assert.match(cli, /scripts", "runyard-update\.sh/);
    assert.match(cli, /spawnSync\("bash"/);
  });
});
