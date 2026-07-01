import { compactText } from "./supportAgentPresentation.js";

export function openAiRequest(provider, { messages, system }) {
  return {
    url: provider.url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.2,
        max_tokens: provider.maxOutputTokens
      })
    }
  };
}

export function anthropicRequest(provider, { messages, system }) {
  return {
    url: provider.url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: provider.model,
        system,
        max_tokens: provider.maxOutputTokens,
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content
          }))
      })
    }
  };
}

export function parseOpenAiReply(data) {
  return String(
    data?.choices?.[0]?.message?.content
    || data?.output_text
    || data?.output?.[0]?.content?.[0]?.text
    || ""
  );
}

export function parseAnthropicReply(data) {
  return Array.isArray(data?.content)
    ? data.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim()
    : "";
}

export async function supportAgentHttpError(response) {
  const text = await response.text().catch(() => "");
  return new Error(`support agent LLM request failed (${response.status}): ${compactText(text, 240)}`);
}
