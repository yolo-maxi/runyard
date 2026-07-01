import {
  SUPPORT_AGENT_CAPABILITY_SLUG,
  compactText,
  extractRunnerReply
} from "./supportAgentPresentation.js";

function supportChatOrigin() {
  return {
    type: "support-chat",
    label: "Runyard support chat"
  };
}

function supportChatRunInput({ system, messages, context }) {
  return {
    system,
    messages,
    context,
    __origin: supportChatOrigin()
  };
}

function supportChatRunOptions() {
  return {
    requestedBy: "support-chat",
    origin: supportChatOrigin()
  };
}

function supportChatQueuedEvent({ messages, context }) {
  return {
    turns: messages.length,
    view: context?.view || ""
  };
}

export function createSupportAgentRunnerProvider({
  addRunEvent,
  createRun,
  getCapability,
  getRun,
  supportRunnerAvailability,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
}) {
  return async function callRunnerProvider(provider, { messages, system, context, signal }) {
    const capability = getCapability(SUPPORT_AGENT_CAPABILITY_SLUG);
    if (!capability || !capability.enabled) {
      throw new Error("support agent runner capability is not installed");
    }
    const runner = supportRunnerAvailability();
    if (!runner.available) {
      throw new Error(`support agent runner unavailable: ${runner.reason}`);
    }
    const run = createRun(
      capability,
      supportChatRunInput({ system, messages, context }),
      supportChatRunOptions()
    );
    addRunEvent(run.id, "support_chat.queued", "Queued Runyard support agent chat", supportChatQueuedEvent({
      messages,
      context
    }));

    const deadline = now() + provider.timeoutMs;
    // Most support answers come back quickly. Poll tightly at first to keep the
    // chat feeling responsive, then back off for slower runner executions.
    let poll = 0;
    const pollDelay = () => (poll < 12 ? 75 : poll < 24 ? 200 : 500);
    while (now() < deadline) {
      if (signal?.aborted) throw new Error("support agent request aborted");
      const current = getRun(run.id);
      if (current?.status === "succeeded") {
        const reply = extractRunnerReply(current);
        return {
          reply: reply || "I finished the support run, but it did not return a reply.",
          raw: { runId: run.id, status: current.status }
        };
      }
      if (["failed", "cancelled", "errored"].includes(current?.status)) {
        throw new Error(`support agent run ${current.status}: ${compactText(current.error || "no error reported", 240)}`);
      }
      await sleep(pollDelay());
      poll += 1;
    }
    const status = getRun(run.id)?.status || "unknown";
    throw new Error(`support agent timed out while answering in chat (internal status: ${status})`);
  };
}

export const __test = {
  supportChatQueuedEvent,
  supportChatRunInput,
  supportChatRunOptions
};
