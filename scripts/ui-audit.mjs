#!/usr/bin/env node
// UI eval-gate harness. Drives headless Chromium over the DevTools Protocol
// (Node 22's global WebSocket — no playwright/puppeteer dependency) to, for
// every page at 360/768/1280/1680:
//   - check for console errors / uncaught exceptions
//   - check for horizontal overflow (scrollWidth > innerWidth)
//   - capture a screenshot into ui-polish-screens/<label>/
// Usage: node scripts/ui-audit.mjs <label>   (label = before|after|...)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.argv[2] || "audit";
const BASE = process.env.HUB_BASE || "http://localhost:43117";
const WIDTHS = [360, 768, 1280, 1680];
const OUT = join(root, "ui-polish-screens", LABEL);
mkdirSync(OUT, { recursive: true });

const token = (process.env.HUB_TOKEN || readFileSync(process.env.HUB_TOKEN_FILE || join(root, "data", "bootstrap-token.txt"), "utf8")).trim();

// ---- tiny CDP client over WebSocket ---------------------------------------
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(e));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: r, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : r(msg.result);
    } else if (msg.method) {
      (listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
    }
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify(payload));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close()
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function main() {
  // Discover real ids so detail pages render with content.
  const runs = (await getJSON("/api/runs"))?.runs || (await getJSON("/api/runs")) || [];
  const runId = Array.isArray(runs) ? runs[0]?.id : runs?.runs?.[0]?.id;
  const wfs = (await getJSON("/api/capabilities"))?.capabilities || (await getJSON("/api/workflows")) || [];
  const wfSlug = Array.isArray(wfs) ? wfs[0]?.slug || wfs[0]?.name : undefined;

  const ROUTES = [
    ["runs", "#runs"],
    ["run-detail", runId ? `#runs/${encodeURIComponent(runId)}` : null],
    ["workflows", "#workflows"],
    ["workflow-detail", wfSlug ? `#workflows/${encodeURIComponent(wfSlug)}` : null],
    ["approvals", "#approvals"],
    ["runners", "#runners"],
    ["schedules", "#schedules"],
    ["agents", "#agents/agents"],
    ["tokens", "#tokens"],
    ["secrets", "#secrets"],
    ["audit", "#audit"],
    ["settings", "#settings"],
    ["connect", "#connect"],
    ["brand", "#brand"]
  ].filter(([, h]) => h);

  // Launch Chromium with remote debugging.
  const chrome = spawn(
    "chromium",
    [
      "--headless=new",
      "--remote-debugging-port=9333",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--user-data-dir=/tmp/ui-audit-profile",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  // Wait for the debugging endpoint.
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch("http://localhost:9333/json/version")).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("chromium debug endpoint never came up");

  const browser = cdpConnect(version.webSocketDebuggerUrl);
  await browser.ready;
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => browser.send(m, p, sessionId);

  await S("Page.enable");
  await S("Runtime.enable");
  await S("Log.enable");
  await S("Network.enable");
  // Seed the session cookie by logging in over HTTP and copying Set-Cookie.
  const login = await fetch(`${BASE}/api/auth/token-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  const setCookie = login.headers.get("set-cookie") || "";
  const m = setCookie.match(/shub_session=([^;]+)/);
  if (m) {
    await S("Network.setCookie", {
      name: "shub_session",
      value: decodeURIComponent(m[1]),
      url: BASE,
      httpOnly: true
    });
  }

  const errors = [];
  browser.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") errors.push(p.args?.map((a) => a.value || a.description).join(" "));
  });
  browser.on("Runtime.exceptionThrown", (p) =>
    errors.push("EXC: " + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text))
  );
  browser.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error") errors.push("LOG: " + p.entry.text);
  });

  const report = [];
  for (const [name, hash] of ROUTES) {
    for (const width of WIDTHS) {
      errors.length = 0;
      await S("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 768
      });
      await S("Page.navigate", { url: `${BASE}/app${hash}` });
      await sleep(1500);
      const overflow = await S("Runtime.evaluate", {
        expression:
          "JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight})",
        returnByValue: true
      });
      const { sw, iw, h } = JSON.parse(overflow.result.value);
      const overflowPx = sw - iw;
      const shot = await S("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.min(h, 4000), scale: 1 }
      });
      writeFileSync(join(OUT, `${name}__${width}.png`), Buffer.from(shot.data, "base64"));
      const rowErrors = [...new Set(errors.filter(Boolean))];
      report.push({ name, width, overflowPx, errors: rowErrors });
      const flag = overflowPx > 1 ? `OVERFLOW+${overflowPx}` : "ok";
      const errFlag = rowErrors.length ? `ERR(${rowErrors.length})` : "";
      console.log(`${name.padEnd(18)} ${String(width).padStart(4)}  ${flag.padEnd(14)} ${errFlag}`);
      if (rowErrors.length) rowErrors.forEach((e) => console.log(`      ${String(e).slice(0, 160)}`));
    }
  }

  writeFileSync(join(OUT, "_report.json"), JSON.stringify(report, null, 2));
  const overflows = report.filter((r) => r.overflowPx > 1);
  const errored = report.filter((r) => r.errors.length);
  console.log(`\n== ${LABEL}: ${report.length} shots, ${overflows.length} overflow, ${errored.length} with console errors ==`);
  browser.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
