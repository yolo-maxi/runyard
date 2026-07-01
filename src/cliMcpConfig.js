import os from "node:os";
import path from "node:path";

export function mcpServerName(remoteName = "default") {
  const remote = String(remoteName || "default");
  return remote === "default" ? "runyard" : `runyard-${remote}`;
}

export function mcpServerSpec(remoteName, { resolveRemote, mcpJs, nodePath = process.execPath } = {}) {
  const remote = resolveRemote ? resolveRemote(remoteName).name : String(remoteName || "default");
  return { command: nodePath, args: [mcpJs, "--remote", remote] };
}

export function mcpJsonEntry(server) {
  return { command: server.command, args: server.args };
}

export function vscodeMcpJsonEntry(server) {
  return { type: "stdio", command: server.command, args: server.args };
}

export function mergeMcpJsonConfig(data, name, server, { key = "mcpServers", entry = mcpJsonEntry } = {}) {
  return {
    ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
    [key]: {
      ...((data && typeof data === "object" && data[key]) || {}),
      [name]: entry(server)
    }
  };
}

export function upsertMcpTomlServer(content, name, server) {
  const block = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)\\[mcp_servers\\.${esc}\\][\\s\\S]*?(?=\\n\\[|$)`);
  const source = String(content || "");
  const next = re.test(source)
    ? source.replace(re, (match, prefix) => `${prefix || ""}${block.trimEnd()}`)
    : `${source.replace(/\s*$/, "")}${source.trim() ? "\n\n" : ""}${block}`;
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function claudeDesktopConfigPath({
  home = os.homedir(),
  platform = process.platform,
  appData = process.env.APPDATA
} = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(appData || home, "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}
