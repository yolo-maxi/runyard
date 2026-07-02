import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

const blockedTargets = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]) {
  blockedTargets.addSubnet(address, prefix, "ipv4");
}
blockedTargets.addAddress("255.255.255.255", "ipv4");

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
]) {
  blockedTargets.addSubnet(address, prefix, "ipv6");
}

function cleanHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function blockedHttpTargetReason(urlValue) {
  let parsed;
  try {
    parsed = new URL(String(urlValue || ""));
  } catch {
    return "invalid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "URL must use http or https";
  if (parsed.username || parsed.password) return "URL must not include credentials";
  const hostname = cleanHostname(parsed.hostname);
  if (!hostname) return "URL must include a hostname";
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "localhost targets are not allowed";
  const version = isIP(hostname);
  if (!version) return "";
  return blockedIpReason(hostname, version);
}

export function blockedIpReason(address, version = isIP(cleanHostname(address))) {
  if (!version) return "";
  const type = version === 4 ? "ipv4" : "ipv6";
  return blockedTargets.check(cleanHostname(address), type)
    ? "private, local, reserved, or multicast targets are not allowed"
    : "";
}

export async function assertSafeHttpTarget(urlValue, {
  allowPrivateTargets = false,
  lookup = dns.lookup
} = {}) {
  if (allowPrivateTargets) return;
  const localReason = blockedHttpTargetReason(urlValue);
  if (localReason) throw new Error(`unsafe response endpoint URL: ${localReason}`);

  const parsed = new URL(String(urlValue || ""));
  const hostname = cleanHostname(parsed.hostname);
  if (isIP(hostname)) return;

  let addresses = [];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    if (error?.code === "ENOTFOUND" || error?.code === "ENODATA") return;
    throw new Error(`unsafe response endpoint URL: DNS lookup failed for ${hostname}`);
  }
  for (const entry of addresses || []) {
    const address = cleanHostname(entry?.address);
    const reason = blockedIpReason(address);
    if (reason) {
      throw new Error(`unsafe response endpoint URL: ${hostname} resolved to ${address}; ${reason}`);
    }
  }
}
