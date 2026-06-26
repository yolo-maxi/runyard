#!/usr/bin/env node
// Copies third-party browser CSS under public/vendor/.
//
// The JavaScript dependencies are bundled into public/app.js by build-web.mjs;
// only React Flow and highlight.js stylesheets are linked directly from
// public/index.html. Keeping this step CSS-only avoids shipping unused vendor
// JavaScript bundles while preserving the self-hosted runtime.
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });

// Pull in the stylesheets so we don't load a remote URL at runtime.
const cssTargets = [
  { from: join(root, "node_modules", "@xyflow", "react", "dist", "style.css"), to: join(out, "reactflow.css") },
  { from: join(root, "node_modules", "highlight.js", "styles", "atom-one-light.css"), to: join(out, "highlight.css") },
  { from: join(root, "node_modules", "highlight.js", "styles", "atom-one-dark.css"), to: join(out, "highlight-dark.css") }
];
for (const { from, to } of cssTargets) {
  if (!existsSync(from)) throw new Error(`missing vendor css source ${from}`);
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}

// Stamp a tiny manifest so the front-end can detect a stale/missing bundle.
const manifest = {
  bundles: [],
  styles: ["reactflow.css", "highlight.css", "highlight-dark.css"]
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log("wrote manifest.json");
