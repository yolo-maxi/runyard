import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient.js";
import { AuthGate } from "./app/AuthGate.jsx";

// Entry point for the Hub's React + TanStack frontend. esbuild bundles this
// (and everything it imports — React, TanStack, ReactFlow, highlight.js) into
// public/app.js, which public/index.html loads as a module. See bin/build-web.mjs.

function mount() {
  const host = document.getElementById("root");
  if (!host) {
    console.error("[runyard] #root mount node missing");
    return;
  }
  createRoot(host).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
      </QueryClientProvider>
    </StrictMode>
  );
}

mount();
