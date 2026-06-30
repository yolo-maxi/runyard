import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function createCliTarballBuilder({ root, dataDir, exists = existsSync, execFile = execFileSync } = {}) {
  let cliTarballPath = null;
  return function buildCliTarball() {
    if (cliTarballPath && exists(cliTarballPath)) return cliTarballPath;
    const out = path.join(dataDir, "cli.tgz");
    const paths = ["bin", "src", "package.json"];
    if (exists(path.join(root, "workflow-templates"))) paths.push("workflow-templates");
    if (exists(path.join(root, "node_modules", "commander"))) paths.push("node_modules/commander");
    execFile("tar", ["czhf", out, "-C", root, ...paths]);
    cliTarballPath = out;
    return out;
  };
}

export function installScript(hubUrl) {
  return `#!/usr/bin/env bash
set -euo pipefail
HUB_URL="\${RUNYARD_HUB_URL:-\${SMITHERS_HUB_URL:-${hubUrl}}}"
APP="$HOME/.runyard/app"
BIN="$HOME/.local/bin"
echo "Installing RunYard client from $HUB_URL ..."
command -v node >/dev/null 2>&1 || { echo "Error: Node.js 18+ is required (https://nodejs.org)."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required."; exit 1; }
mkdir -p "$APP" "$BIN"
tmp="$(mktemp)"
curl -fsSL "$HUB_URL/cli.tgz" -o "$tmp"
tar xzf "$tmp" -C "$APP"
rm -f "$tmp"
cat > "$BIN/runyard" <<WRAP
#!/usr/bin/env bash
exec node "$APP/src/cli.js" "\\$@"
WRAP
cat > "$BIN/runyard-mcp" <<WRAP
#!/usr/bin/env bash
exec node "$APP/src/mcp.js" "\\$@"
WRAP
chmod +x "$BIN/runyard" "$BIN/runyard-mcp"
TOKEN="\${RUNYARD_HUB_TOKEN:-\${SMITHERS_HUB_TOKEN:-}}"
REMOTE="\${RUNYARD_HUB_REMOTE:-\${SMITHERS_HUB_REMOTE:-}}"
# Ask for the token + a name for this connection (org) on first run.
if [ -z "$TOKEN" ] && [ -r /dev/tty ]; then
  printf "Paste your RunYard access token (Web Hub -> Connect): " > /dev/tty
  read -r TOKEN < /dev/tty
fi
if [ -z "$REMOTE" ] && [ -r /dev/tty ]; then
  printf "Name this org connection [default]: " > /dev/tty
  read -r REMOTE < /dev/tty
fi
REMOTE="\${REMOTE:-default}"
if [ -n "$TOKEN" ]; then
  node "$APP/src/cli.js" login --remote "$REMOTE" --url "$HUB_URL" --token "$TOKEN" >/dev/null && echo "Logged in to $HUB_URL (remote: $REMOTE)"
else
  echo "No token entered. Log in later with:  runyard login --url $HUB_URL"
fi
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add this to your shell profile:  export PATH=\\"$BIN:\\$PATH\\"" ;;
esac
echo ""
echo "Installed. Next:"
echo "  runyard capabilities      # see what you can run"
echo "  runyard tail <run-id>     # watch a run's unified timeline"
echo "  runyard mcp install --all # connect every AI agent on this machine"
`;
}
