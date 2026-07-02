#!/usr/bin/env node
// Bundles the Hub's React + TanStack single-page app (web/main.jsx and the rest
// of web/) into public/app.js — the module that public/index.html loads. The
// bundle is fully self-contained (React, ReactDOM, @xyflow/react, highlight.js,
// and the TanStack packages are all bundled in), so the Hub stays self-hosted:
// no runtime CDN, the same CSP that protects the rest of the app, and the
// Gateway-backed HTTP adapter keeps serving the output with zero server changes.
//
// Run with `pnpm build:web`. Pass --watch for an incremental dev rebuild.
//
// Note: the stylesheets (reactflow.css, highlight.css) are still produced by
// `pnpm build:vendor`, which index.html links directly. `pnpm build` runs both
// steps for release builds.
import { build, context } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "web", "main.jsx");
const outfile = join(root, "public", "app.js");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");
const require = createRequire(import.meta.url);
const reactPeerRe = /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/;

function resolveAppPeer(specifier) {
  try {
    return require.resolve(specifier, { paths: [root] });
  } catch {
    return null;
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  target: ["es2020"],
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx", ".jsx": "jsx" },
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  absWorkingDir: root,
  nodePaths: [join(root, "node_modules")],
  outfile,
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  plugins: [
    {
      name: "runyard-react-peer-dedupe",
      setup(build) {
        build.onResolve({ filter: reactPeerRe }, (args) => {
          const peerPath = resolveAppPeer(args.path);
          return peerPath ? { path: peerPath } : undefined;
        });
      }
    }
  ],
  logLevel: "info"
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching web/ -> ${outfile}`);
} else {
  await build(options);
  console.log(`built web app -> ${outfile}`);
}
