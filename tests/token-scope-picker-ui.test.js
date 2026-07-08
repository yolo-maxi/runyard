import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The Tokens/Connect scope UI: preset buttons (Everything default, Read-only
// one click), collapsible scope groups, and the exact scope payload submitted
// to POST /api/tokens. The picker renders here with the REAL server scope
// vocabulary (src/tokenRoutes.js) so UI copy and backend presets cannot drift.

const tempRoot = path.join(process.cwd(), "test-artifacts");
mkdirSync(tempRoot, { recursive: true });
const temp = mkdtempSync(path.join(tempRoot, "runyard-scope-picker-"));
const bundlePath = path.join(temp, "scope-picker.mjs");

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

async function loadHarness() {
  await build({
    stdin: {
      sourcefile: "scope-picker-harness.jsx",
      resolveDir: process.cwd(),
      loader: "jsx",
      contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { EVERYTHING_SCOPES, ScopePicker, equalScopeSets, presetForScopes } from "./web/components/ScopePicker.jsx";
        import {
          DEFAULT_TOKEN_SCOPES,
          KNOWN_TOKEN_SCOPES,
          TOKEN_PRESETS,
          TOKEN_SCOPE_METADATA
        } from "./src/tokenRoutes.js";

        export const meta = {
          scopes: TOKEN_SCOPE_METADATA,
          presets: TOKEN_PRESETS,
          defaultScopes: DEFAULT_TOKEN_SCOPES,
          known: KNOWN_TOKEN_SCOPES
        };
        export { EVERYTHING_SCOPES, equalScopeSets, presetForScopes };
        export function renderPicker(selected) {
          return renderToStaticMarkup(
            <ScopePicker selected={new Set(selected)} onChange={() => {}} meta={meta} />
          );
        }
      `
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    packages: "external",
    jsx: "automatic",
    loader: { ".js": "jsx", ".jsx": "jsx" },
    outfile: bundlePath,
    logLevel: "silent"
  });
  return import(pathToFileURL(bundlePath).href);
}

describe("token scope picker", () => {
  it("defaults to the Everything preset and shows collapsible scope groups", async () => {
    const { EVERYTHING_SCOPES, meta, presetForScopes, renderPicker } = await loadHarness();

    // The UI default matches the backend's default preset exactly.
    const everything = meta.presets.find((preset) => preset.default);
    assert.deepEqual([...EVERYTHING_SCOPES].sort(), [...everything.scopes].sort());
    assert.equal(presetForScopes(EVERYTHING_SCOPES, meta).id, "everything");

    const html = renderPicker(EVERYTHING_SCOPES);
    // Every preset is one click, and the active one is highlighted.
    for (const preset of meta.presets) {
      assert.ok(html.includes(`>${preset.title}</button>`), `preset button ${preset.id}`);
    }
    assert.match(html, /class="button primary"[^>]*>Everything</);
    // Collapsible groups with selection counts; api/mcp/approvals checked.
    assert.match(html, /<details class="scope-group">/);
    assert.match(html, /Operate<\/?[a-z]*[^>]*> · 3\/3 selected/);
    assert.match(html, /Inspect[^·]*· 0\/1 selected/);
    assert.equal((html.match(/checked=""/g) || []).length, 3);
    // Each scope row spells out what it grants, from the server vocabulary.
    for (const entry of meta.scopes) {
      assert.ok(html.includes(`<code>${entry.scope}</code>`), `scope row ${entry.scope}`);
    }
  });

  it("renders the read-only preset as active for a read-scope selection", async () => {
    const { meta, presetForScopes, renderPicker } = await loadHarness();
    const html = renderPicker(["read"]);
    assert.match(html, /class="button primary"[^>]*>Read-only</);
    assert.match(html, /Inspect[^·]*· 1\/1 selected/);
    assert.equal((html.match(/checked=""/g) || []).length, 1);
    assert.equal(presetForScopes(["read"], meta).id, "read-only");
    // A custom mix maps to no preset.
    assert.equal(presetForScopes(["api", "runner"], meta), null);
  });

  it("Tokens and Connect submit exactly the picked scopes in server order", () => {
    const tokens = readFileSync("web/views/Tokens.jsx", "utf8");
    const connect = readFileSync("web/views/Connect.jsx", "utf8");
    for (const [file, source] of [["Tokens.jsx", tokens], ["Connect.jsx", connect]]) {
      assert.match(source, /ScopePicker/, `${file} uses the shared ScopePicker`);
      assert.match(source, /new Set\(EVERYTHING_SCOPES\)/, `${file} defaults to Everything`);
      assert.match(source, /known\.filter\(\(s(cope)?\) => scopes\.has\(s(cope)?\)\)/, `${file} submits picked scopes in server order`);
      assert.match(source, /\/api\/tokens\/scopes/, `${file} loads the scope vocabulary from the API`);
    }
    // The old hardcoded client-side scope lists are gone.
    assert.doesNotMatch(tokens, /TOKEN_SCOPES\s*=/);
    assert.doesNotMatch(connect, /INVITE_SCOPES\s*=/);
    // The token list shows a readable preset label next to raw scopes.
    assert.match(tokens, /TokenScopes/);
    // Onboarding's runner token mint stays simple and hard-coded to runner.
    assert.match(readFileSync("web/views/Onboarding.jsx", "utf8"), /scopes:\s*\["runner"\]/);
  });
});
