import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Fully static export: `next build` writes plain HTML/assets to out/,
  // served by the hub's Express static handler. No Node server at runtime.
  output: 'export',
  // The hub mounts the site at /docs (express.static under that prefix).
  // If this changes, also update `basePath` in lib/shared.ts.
  basePath: '/docs',
  // Nested routes export as directories with index.html so a dumb static
  // server resolves /docs/guides/getting-started/ without rewrite rules.
  trailingSlash: true,
  // next/image optimization needs a server; not available in static export.
  images: { unoptimized: true },
  reactStrictMode: true,
  // The repo root also has a pnpm-lock.yaml; pin the workspace root so
  // Turbopack doesn't infer the parent project as the root.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
