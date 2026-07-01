import {
  anthropicRequest,
  openAiRequest,
  parseAnthropicReply,
  parseOpenAiReply,
  supportAgentHttpError
} from "./supportAgentHttpProviders.js";

export async function callOpenAiProvider(provider, { messages, system, signal, fetchImpl = fetch }) {
  const request = openAiRequest(provider, { messages, system });
  const response = await fetchImpl(request.url, { ...request.init, signal });
  if (!response.ok) {
    throw await supportAgentHttpError(response);
  }
  const data = await response.json();
  return { reply: parseOpenAiReply(data), raw: data };
}

export async function callAnthropicProvider(provider, { messages, system, signal, fetchImpl = fetch }) {
  const request = anthropicRequest(provider, { messages, system });
  const response = await fetchImpl(request.url, { ...request.init, signal });
  if (!response.ok) {
    throw await supportAgentHttpError(response);
  }
  const data = await response.json();
  return { reply: parseAnthropicReply(data), raw: data };
}
