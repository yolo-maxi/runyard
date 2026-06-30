import { deepLinks } from "./deepLinks.js";

export function normalizeChainSteps(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((step) => {
      if (typeof step === "string") return { capability: step, input: {} };
      if (!step || typeof step !== "object") return null;
      const capability = String(step.capability || step.capabilitySlug || step.slug || "").trim();
      if (!capability) return null;
      const input = step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input : {};
      return {
        capability,
        input,
        title: step.title ? String(step.title) : "",
        passPreviousOutput: step.passPreviousOutput !== false
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

export function chainMetadata(input = {}) {
  const chain = normalizeChainSteps(input.__chain || input.chain);
  const index = Number.isFinite(Number(input.__chainIndex)) ? Number(input.__chainIndex) : 0;
  return { chain, index: Math.max(0, index) };
}

export function attachChainToInput(input, chain) {
  if (!Array.isArray(chain) || !input || typeof input !== "object" || Array.isArray(input)) return input;
  input.__chain = normalizeChainSteps(chain);
  input.__chainIndex = 0;
  return input;
}

export function nextChainedRunInput({ parentRun, output, chain, index, next }) {
  const nextInput = {
    ...(next.input || {}),
    __chain: chain,
    __chainIndex: index + 1,
    previousRun: {
      id: parentRun.id,
      capabilitySlug: parentRun.capabilitySlug,
      capabilityName: parentRun.capabilityName,
      status: parentRun.status,
      deepLink: deepLinks.run(parentRun.id)
    }
  };
  if (next.passPreviousOutput !== false) nextInput.previousOutput = output || parentRun.output || null;
  return nextInput;
}

export function nextChainedRunOrigin(parentRun, chain, index) {
  return {
    label: `Chained from ${parentRun.capabilitySlug} ${parentRun.id}`,
    type: "workflow-chain",
    parentRunId: parentRun.id,
    chainIndex: index + 1,
    chainLength: chain.length
  };
}
