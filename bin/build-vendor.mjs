#!/usr/bin/env node
// Bundles the third-party browser dependencies (React, React Flow, highlight.js)
// into self-contained ES modules under public/vendor/. Re-run with `pnpm
// build:vendor` whenever any of those upstream packages change.
//
// The output is what /app loads at runtime, so the Hub stays self-hosted: no
// runtime CDN, the same CSP that protects the rest of the app, and zero new
// build steps for the express server.
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
const work = join(tmpdir(), `smithers-hub-vendor-${process.pid}`);
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const entryReactflow = join(work, "entry-reactflow.mjs");
writeFileSync(
  entryReactflow,
  `// Auto-generated entry — bundled by bin/build-vendor.mjs.
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactFlow from "@xyflow/react";
export { React, ReactDOM, ReactDOMClient, ReactFlow };
export default { React, ReactDOM, ReactDOMClient, ReactFlow };
`
);

const entryHighlight = join(work, "entry-highlight.mjs");
writeFileSync(
  entryHighlight,
  `// Auto-generated entry — bundled by bin/build-vendor.mjs.
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);

export default hljs;
export { hljs };
`
);

async function bundle(entry, outfile, label) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    outfile,
    define: { "process.env.NODE_ENV": '"production"' }
  });
  console.log(`built ${label} -> ${outfile}`);
}

await bundle(entryReactflow, join(out, "reactflow.bundle.js"), "reactflow + react");
await bundle(entryHighlight, join(out, "highlight.bundle.js"), "highlight.js");

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
  generatedAt: new Date().toISOString(),
  bundles: ["reactflow.bundle.js", "highlight.bundle.js"],
  styles: ["reactflow.css", "highlight.css", "highlight-dark.css"]
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log("wrote manifest.json");

rmSync(work, { recursive: true, force: true });
