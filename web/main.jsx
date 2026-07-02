import { StrictMode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
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
  createGatewayReactRoot(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
      </QueryClientProvider>
    </StrictMode>,
    { baseUrl: "/", rootId: "root" }
  );
}

mount();
