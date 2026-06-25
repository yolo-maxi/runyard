// Headless eval gate for public/landing.html.
// Serves public/ over a tiny static server (so /public/styles.css resolves),
// then loads landing.html in chromium at five widths, asserting:
//   - no console errors / page errors
//   - no horizontal overflow (scrollWidth <= innerWidth)
// and screenshots each width into landing-shots/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pw from "/home/xiko/telegram-tt/node_modules/playwright-core/index.js";
const { chromium } = pw;

const root = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(root, "landing-shots");
fs.mkdirSync(shotsDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};

// Minimal static server. "/" -> landing.html, "/public/*" -> public/*.
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  let file;
  if (url === "/" || url === "/index-landing") file = path.join(root, "public", "landing.html");
  else if (url.startsWith("/public/")) file = path.join(root, url.replace("/public/", "public/"));
  else file = path.join(root, "public", url.replace(/^\//, ""));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found: " + url); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

const WIDTHS = [360, 390, 414, 768, 1280];

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
let failed = false;
const summary = [];

for (const w of WIDTHS) {
  const isMobile = w < 768;
  const ctx = await browser.newContext({ viewport: { width: w, height: isMobile ? 800 : 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: "networkidle" });

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  const overflow = metrics.scrollWidth > metrics.innerWidth;

  const tag = isMobile ? "mobile" : "desktop";
  const shot = path.join(shotsDir, `landing-${tag}-${w}.png`);
  await page.screenshot({ path: shot, fullPage: true });

  const ok = !overflow && errors.length === 0;
  if (!ok) failed = true;
  summary.push({ w, scrollWidth: metrics.scrollWidth, innerWidth: metrics.innerWidth, overflow, errors, shot, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${w}px  scrollW=${metrics.scrollWidth} innerW=${metrics.innerWidth}` +
    `${overflow ? "  <<OVERFLOW>>" : ""}${errors.length ? "  errors=" + JSON.stringify(errors) : ""}  -> ${path.relative(root, shot)}`
  );
  await ctx.close();
}

await browser.close();
server.close();

console.log("\n" + (failed ? "RESULT: FAIL" : "RESULT: ALL GREEN"));
process.exit(failed ? 1 : 0);
