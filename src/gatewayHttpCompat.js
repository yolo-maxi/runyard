import { EventEmitter } from "node:events";
import { createReadStream, existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { Gateway } from "@smithers-orchestrator/server/light-gateway";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const TRUST_PROXY_RANGES = {
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  loopback: ["127.0.0.1/8", "::1/128"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
};

const trustNone = () => false;
const trustAll = () => true;

function parseByteLimit(value, fallback = 1_048_576) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return fallback;
  const size = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const scale = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(size * scale);
}

function cleanIpAddress(address) {
  let value = String(address || "").trim();
  if (!value) return "";
  if (value.startsWith("[")) {
    const closeIndex = value.indexOf("]");
    if (closeIndex !== -1) value = value.slice(1, closeIndex);
  } else {
    const ipv4Port = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4Port) value = ipv4Port[1];
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  return value;
}

function ipv4ToBigInt(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function ipv6Groups(address) {
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = lastColon === -1 ? null : ipv4ToBigInt(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;

  return groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    return Number.parseInt(group, 16);
  });
}

function ipv6ToBigInt(address) {
  const groups = ipv6Groups(address);
  if (!groups || groups.some((group) => group === null || group < 0 || group > 0xffff)) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n);
}

function mappedIpv4FromIpv6(address) {
  const groups = ipv6Groups(address);
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return null;
  return {
    version: 4,
    bits: 32,
    value: (BigInt(groups[6]) << 16n) + BigInt(groups[7])
  };
}

function parseIp(address) {
  const value = cleanIpAddress(address);
  const version = isIP(value);
  if (version === 4) {
    return { version, bits: 32, value: ipv4ToBigInt(value) };
  }
  if (version === 6) {
    return {
      version,
      bits: 128,
      value: ipv6ToBigInt(value),
      mappedIpv4: mappedIpv4FromIpv6(value)
    };
  }
  return null;
}

function parseTrustRange(entry) {
  const [address, prefix, extra] = String(entry || "").trim().split("/");
  if (!address || extra !== undefined) return null;
  const parsed = parseIp(address);
  if (!parsed || parsed.value === null) return null;
  const bits = parsed.version === 4 ? 32 : 128;
  const rangePrefix = prefix === undefined || prefix === "" ? bits : Number(prefix);
  if (!Number.isInteger(rangePrefix) || rangePrefix < 0 || rangePrefix > bits) return null;
  return { version: parsed.version, bits, prefix: rangePrefix, value: parsed.value };
}

function expandTrustEntry(entry) {
  const value = String(entry || "").trim();
  if (!value) return [];
  const namedRanges = TRUST_PROXY_RANGES[value.toLowerCase()];
  if (namedRanges) return namedRanges.map(parseTrustRange).filter(Boolean);
  const range = parseTrustRange(value);
  return range ? [range] : [];
}

function ipMatchesRange(ip, range) {
  if (!ip || ip.version !== range.version || ip.value === null) return false;
  const shift = BigInt(range.bits - range.prefix);
  const mask = range.prefix === 0 ? 0n : ((1n << BigInt(range.prefix)) - 1n) << shift;
  return (ip.value & mask) === (range.value & mask);
}

function compileTrustProxy(setting) {
  if (typeof setting === "function") return setting;
  if (setting === true) return trustAll;
  if (setting === false || setting == null) return trustNone;

  if (typeof setting === "number") {
    if (!Number.isFinite(setting) || setting <= 0) return trustNone;
    const hops = Math.floor(setting);
    return (_address, index = 0) => index < hops;
  }

  if (typeof setting === "string") {
    const value = setting.trim();
    const lower = value.toLowerCase();
    if (!value || lower === "false" || lower === "off" || lower === "no" || lower === "0") return trustNone;
    if (lower === "true") return trustAll;
    if (/^\d+$/.test(value)) return compileTrustProxy(Number(value));
  }

  const entries = (Array.isArray(setting) ? setting : String(setting).split(",")).flatMap((entry) => String(entry).split(","));
  const ranges = entries.flatMap(expandTrustEntry);
  if (!ranges.length) return trustNone;
  return (address) => {
    const parsed = parseIp(address);
    if (!parsed) return false;
    return ranges.some((range) => ipMatchesRange(parsed, range) || ipMatchesRange(parsed.mappedIpv4, range));
  };
}

function trustedHop(trust, address, index) {
  try {
    return Boolean(trust(address, index));
  } catch {
    return false;
  }
}

function requestHeader(req, name) {
  const value = req.headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.join(",");
  return value == null ? "" : String(value);
}

function forwardedHeaderValues(req, name) {
  return requestHeader(req, name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function remoteAddress(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || "";
}

function resolveClientAddresses(req, trust) {
  const remote = remoteAddress(req);
  const forwardedFor = forwardedHeaderValues(req, "x-forwarded-for");
  const addresses = [remote, ...forwardedFor.reverse()];
  let trusted = addresses;
  for (let index = 0; index < addresses.length - 1; index += 1) {
    if (!trustedHop(trust, addresses[index], index)) {
      trusted = addresses.slice(0, index + 1);
      break;
    }
  }
  return {
    ip: trusted[trusted.length - 1] || "",
    ips: trusted.slice(1).reverse()
  };
}

function isJsonContentType(req) {
  return /\bapplication\/(?:[^;]+\+)?json\b/i.test(String(req.headers["content-type"] || ""));
}

function isUrlencodedContentType(req) {
  return /\bapplication\/x-www-form-urlencoded\b/i.test(String(req.headers["content-type"] || ""));
}

async function readRawBody(req, limitBytes) {
  if (req._rawBody) return req._rawBody;
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      const error = new Error("payload too large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  req._rawBody = Buffer.concat(chunks);
  return req._rawBody;
}

export function json(options = {}) {
  const limit = parseByteLimit(options.limit);
  return async (req, _res, next) => {
    if (!METHODS.has(req.method) || !isJsonContentType(req)) {
      req.body ??= {};
      return next();
    }
    try {
      const raw = await readRawBody(req, limit);
      if (!raw.length) {
        req.body = {};
        return next();
      }
      req.body = JSON.parse(raw.toString("utf8"));
      return next();
    } catch (error) {
      if (error instanceof SyntaxError) {
        error.status = 400;
        error.type = "entity.parse.failed";
      }
      return next(error);
    }
  };
}

export function urlencoded(options = {}) {
  const limit = parseByteLimit(options.limit);
  return async (req, _res, next) => {
    if (!METHODS.has(req.method) || !isUrlencodedContentType(req)) {
      req.body ??= {};
      return next();
    }
    try {
      const raw = await readRawBody(req, limit);
      req.body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function appendHeader(res, name, value) {
  const current = res.getHeader(name);
  if (current === undefined) {
    res.setHeader(name, value);
  } else if (Array.isArray(current)) {
    res.setHeader(name, [...current, value]);
  } else {
    res.setHeader(name, [current, value]);
  }
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAge) / 1000))}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).replace(/^./, (c) => c.toUpperCase())}`);
  return parts.join("; ");
}

function decorateRequest(req, settings) {
  if (req._runyardDecorated) return req;
  req._runyardDecorated = true;
  const trustProxy = compileTrustProxy(settings.get("trust proxy"));
  const url = new URL(req.url || "/", "http://127.0.0.1");
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams.entries());
  req.params = {};
  const clientAddresses = resolveClientAddresses(req, trustProxy);
  req.ip = clientAddresses.ip;
  req.ips = clientAddresses.ips;
  req.get = (name) => req.headers[String(name).toLowerCase()];
  const forwardedProto = trustedHop(trustProxy, remoteAddress(req), 0) ? forwardedHeaderValues(req, "x-forwarded-proto")[0] || "" : "";
  req.protocol = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  return req;
}

function decorateResponse(res) {
  if (res._runyardDecorated) return res;
  res._runyardDecorated = true;
  res.status = (code) => {
    res.statusCode = Number(code);
    return res;
  };
  res.set = (headers) => {
    for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value);
    return res;
  };
  res.type = (value) => {
    const text = String(value || "");
    res.setHeader("content-type", text.includes("/") ? text : MIME[text.startsWith(".") ? text : `.${text}`] || text);
    return res;
  };
  res.json = (payload) => {
    if (!res.headersSent) res.setHeader("content-type", MIME[".json"]);
    res.end(`${JSON.stringify(payload)}\n`);
    return res;
  };
  res.send = (payload = "") => {
    if (payload && typeof payload === "object" && !Buffer.isBuffer(payload)) return res.json(payload);
    if (typeof payload === "string" && !res.getHeader("content-type")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
    }
    res.end(payload);
    return res;
  };
  res.sendFile = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!res.getHeader("content-type") && MIME[ext]) res.setHeader("content-type", MIME[ext]);
    createReadStream(filePath).on("error", () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end();
    }).pipe(res);
    return res;
  };
  res.redirect = (statusOrLocation, maybeLocation) => {
    const status = typeof statusOrLocation === "number" ? statusOrLocation : 302;
    const location = typeof statusOrLocation === "number" ? maybeLocation : statusOrLocation;
    res.statusCode = status;
    res.setHeader("location", location);
    res.end(`Found. Redirecting to ${location}`);
    return res;
  };
  res.cookie = (name, value, options = {}) => {
    appendHeader(res, "set-cookie", serializeCookie(name, value, options));
    return res;
  };
  res.clearCookie = (name, options = {}) => {
    appendHeader(res, "set-cookie", serializeCookie(name, "", { ...options, expires: new Date(0), maxAge: 0 }));
    return res;
  };
  return res;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRoutePath(pattern) {
  const keys = [];
  if (pattern === "/") return { keys, regexp: /^\/?$/ };
  const source = String(pattern)
    .split("/")
    .map((part) => {
      if (!part) return "";
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(part);
    })
    .join("/");
  return { keys, regexp: new RegExp(`^${source}/?$`) };
}

function routeMatches(entry, req) {
  if (entry.method && entry.method !== req.method) return false;
  if (entry.kind === "use") {
    if (entry.path === "/") return true;
    return req.path === entry.path || req.path.startsWith(`${entry.path}/`);
  }
  const match = entry.regexp.exec(req.path);
  if (!match) return false;
  req.params = {};
  entry.keys.forEach((key, index) => {
    req.params[key] = decodeURIComponent(match[index + 1] || "");
  });
  return true;
}

function normalizeRegisteredPath(routePath) {
  const normalized = String(routePath || "/").trim().replace(/\/+$/, "") || "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/*
 * The Smithers light-gateway owns these HTTP paths before app routes run:
 * - GET /health
 * - GET /workflows
 * - GET /metrics
 * - POST /rpc
 *
 * Smithers gateway RPC protocol v1 uses X-Smithers-API-Version: v1, POST /rpc,
 * and POST /v1/rpc/:method. App routes registered for those concrete paths are
 * never reached because light-gateway answers them first.
 */
const GATEWAY_RESERVED_EXACT_PATHS = [
  { method: "GET", path: "/health", label: "GET /health" },
  { method: "GET", path: "/workflows", label: "GET /workflows" },
  { method: "GET", path: "/metrics", label: "GET /metrics" },
  { method: "POST", path: "/rpc", label: "POST /rpc" }
];
const GATEWAY_RESERVED_RPC_SAMPLE = "/v1/rpc/__method__";

function reservedGatewayShadowForRoute(method, routePath) {
  const normalizedPath = normalizeRegisteredPath(routePath);
  const compiled = compileRoutePath(normalizedPath);
  const exactShadow = GATEWAY_RESERVED_EXACT_PATHS.find((reserved) => (
    reserved.method === method && compiled.regexp.test(reserved.path)
  ));
  if (exactShadow) return exactShadow.label;

  if (method !== "POST") return "";
  if (compiled.regexp.test(GATEWAY_RESERVED_RPC_SAMPLE)) return "POST /v1/rpc/:method";
  if (/^\/v1\/rpc\/[^/]+$/.test(normalizedPath)) return "POST /v1/rpc/:method";
  return "";
}

function usePathCoversReservedPath(pathPrefix, reservedPath) {
  if (pathPrefix === "/") return false;
  return reservedPath === pathPrefix || reservedPath.startsWith(`${pathPrefix}/`);
}

function reservedGatewayShadowForUse(pathPrefix) {
  const normalizedPath = normalizeRegisteredPath(pathPrefix);
  const exactShadow = GATEWAY_RESERVED_EXACT_PATHS.find((reserved) => usePathCoversReservedPath(normalizedPath, reserved.path));
  if (exactShadow) return exactShadow.label;
  if (usePathCoversReservedPath(normalizedPath, GATEWAY_RESERVED_RPC_SAMPLE)) return "POST /v1/rpc/:method";
  return "";
}

function assertNotGatewayReserved(kind, method, routePath) {
  const shadowed = kind === "use"
    ? reservedGatewayShadowForUse(routePath)
    : reservedGatewayShadowForRoute(method, routePath);
  if (!shadowed) return;
  throw new Error(`Cannot register ${kind === "use" ? "middleware" : `${method} route`} for ${routePath}: shadowed by Smithers gateway reserved path ${shadowed}`);
}

async function runHandler(handler, req, res, error) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const next = (nextError) => {
      if (nextError) reject(nextError);
      else finish(true);
    };
    try {
      const result = error === undefined ? handler(req, res, next) : handler(error, req, res, next);
      Promise.resolve(result).then(() => finish(false), reject);
    } catch (caught) {
      reject(caught);
    }
  });
}

export function staticFiles(rootDir) {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const prefix = req._matchedUsePath || "";
    const rawPath = decodeURIComponent(req.path.slice(prefix.length) || "/");
    const requested = path.resolve(root, `.${rawPath}`);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) return next();
    if (!existsSync(requested) || !statSync(requested).isFile()) return next();
    const ext = path.extname(requested).toLowerCase();
    if (MIME[ext]) res.setHeader("content-type", MIME[ext]);
    res.sendFile(requested);
  };
}

class GatewayBackedHttpApp {
  #entries = [];
  #errorHandlers = [];
  #settings = new Map();
  #gatewayOptions = {};

  disable() {
    return this;
  }

  set(key, value) {
    this.#settings.set(key, value);
    return this;
  }

  setGatewayOptions(options) {
    this.#gatewayOptions = { ...(options || {}) };
    return this;
  }

  use(pathOrHandler, ...handlers) {
    const pathPrefix = typeof pathOrHandler === "string" ? pathOrHandler.replace(/\/+$/, "") || "/" : "/";
    if (typeof pathOrHandler === "string") assertNotGatewayReserved("use", null, pathPrefix);
    const stack = typeof pathOrHandler === "string" ? handlers : [pathOrHandler, ...handlers];
    for (const handler of stack.flat()) {
      if (typeof handler !== "function") continue;
      if (handler.length === 4) this.#errorHandlers.push(handler);
      else this.#entries.push({ kind: "use", path: pathPrefix, handlers: [handler] });
    }
    return this;
  }

  #route(method, routePath, handlers) {
    assertNotGatewayReserved("route", method, routePath);
    const compiled = compileRoutePath(routePath);
    this.#entries.push({ kind: "route", method, path: routePath, ...compiled, handlers: handlers.flat() });
    return this;
  }

  get(routePath, ...handlers) {
    return this.#route("GET", routePath, handlers);
  }

  post(routePath, ...handlers) {
    return this.#route("POST", routePath, handlers);
  }

  put(routePath, ...handlers) {
    return this.#route("PUT", routePath, handlers);
  }

  patch(routePath, ...handlers) {
    return this.#route("PATCH", routePath, handlers);
  }

  delete(routePath, ...handlers) {
    return this.#route("DELETE", routePath, handlers);
  }

  async handle(req, res) {
    decorateRequest(req, this.#settings);
    decorateResponse(res);
    try {
      for (const entry of this.#entries) {
        if (!routeMatches(entry, req)) continue;
        const previousMatchedUsePath = req._matchedUsePath;
        if (entry.kind === "use") req._matchedUsePath = entry.path === "/" ? "" : entry.path;
        for (const handler of entry.handlers) {
          const continued = await runHandler(handler, req, res);
          if (!continued) return true;
          if (res.writableEnded) return true;
        }
        req._matchedUsePath = previousMatchedUsePath;
      }
    } catch (error) {
      for (const handler of this.#errorHandlers) {
        const continued = await runHandler(handler, req, res, error);
        if (!continued || res.writableEnded) return true;
      }
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "internal server error" });
      return true;
    }
    if (!res.writableEnded) {
      res.status(404).json({ error: "not found" });
    }
    return true;
  }

  listen(port = 0, host, callback) {
    if (typeof host === "function") {
      callback = host;
      host = undefined;
    }
    const gateway = new Gateway({
      operatorUi: false,
      ...this.#gatewayOptions,
      routes: (req, res) => this.handle(req, res)
    });
    const proxy = new EventEmitter();
    let server = null;
    let closeRequested = false;
    proxy.address = () => server?.address();
    proxy.close = (done) => {
      closeRequested = true;
      const finish = () => gateway.close().then(() => done?.(), (error) => done?.(error));
      if (server) finish();
      else proxy.once("listening", finish);
      return proxy;
    };
    gateway.listen({ port, host }).then((bound) => {
      server = bound;
      proxy.emit("listening");
      callback?.();
      if (closeRequested) proxy.close();
    }, (error) => {
      proxy.emit("error", error);
    });
    return proxy;
  }
}

export function createGatewayHttpCompat() {
  return new GatewayBackedHttpApp();
}

createGatewayHttpCompat.json = json;
createGatewayHttpCompat.urlencoded = urlencoded;
createGatewayHttpCompat.static = staticFiles;

export default createGatewayHttpCompat;
