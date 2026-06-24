import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

// Register ONLY the languages the legacy vendored bundle shipped
// (bin/build-vendor.mjs). The matching highlight CSS is already linked from
// index.html, so we never import CSS here. `jsx`/`tsx` alias to their base
// grammars exactly like the legacy build did.
let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("jsx", javascript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("markdown", markdown);
}

// Map a source `language` value (as returned by /api/capabilities/:id/source)
// onto a registered hljs grammar — ts/tsx → typescript, js/jsx → javascript.
function resolveLanguage(language) {
  if (language === "tsx" || language === "ts") return "typescript";
  if (language === "jsx" || language === "js") return "javascript";
  return language || "plaintext";
}

// Syntax-highlighted code block. Ported from the legacy Workflow Code tab —
// `hljs.highlight(code, { language })` with an auto-highlight fallback when the
// language isn't registered, rendered via dangerouslySetInnerHTML inside
// <pre><code class="hljs …">.
export function CodeBlock({ code = "", language = "plaintext", className = "" }) {
  ensureRegistered();
  const lang = resolveLanguage(language);
  const html = useMemo(() => {
    if (!code) return "";
    try {
      if (hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      // best-effort; fall back to escaped raw text so the block is still legible.
      const div = typeof document !== "undefined" ? document.createElement("div") : null;
      if (div) {
        div.textContent = code;
        return div.innerHTML;
      }
      return code;
    }
  }, [code, lang]);
  return (
    <pre className={`workflow-code${className ? ` ${className}` : ""}`}>
      <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
