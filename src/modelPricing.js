// Best-effort model pricing for cost estimation.
//
// Prices are USD per million tokens, which is numerically identical to
// micro-USD per token — so `promptTokens * price.prompt` is already micros.
// The table only carries models whose list price is well known; anything else
// returns null and the usage record simply has no costMicros (never a guess).
// Provider-reported cost, when a gateway upstream returns one, always wins
// over this table (see runUsageStore: metadata.costSource).
const MODEL_PRICES = [
  [/^claude-opus-4/, { prompt: 15, completion: 75 }],
  [/^claude-(?:sonnet-[45]|[45]-sonnet)/, { prompt: 3, completion: 15 }],
  [/^claude-haiku-4/, { prompt: 1, completion: 5 }],
  [/^claude-3-5-haiku/, { prompt: 0.8, completion: 4 }],
  [/^gpt-4o-mini/, { prompt: 0.15, completion: 0.6 }],
  [/^gpt-4o/, { prompt: 2.5, completion: 10 }],
  [/^gpt-4\.1-mini/, { prompt: 0.4, completion: 1.6 }],
  [/^gpt-4\.1-nano/, { prompt: 0.1, completion: 0.4 }],
  [/^gpt-4\.1/, { prompt: 2, completion: 8 }],
  [/^o3-mini/, { prompt: 1.1, completion: 4.4 }],
  [/^o4-mini/, { prompt: 1.1, completion: 4.4 }],
  [/^o3/, { prompt: 2, completion: 8 }]
];

export function modelPrice(model = "") {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return null;
  for (const [pattern, price] of MODEL_PRICES) {
    if (pattern.test(id)) return price;
  }
  return null;
}

// Estimated call cost in micro-USD, or null when the model is not in the
// price table. Cache reads/writes are deliberately ignored — without the
// provider's own cost figure this stays a conservative floor, not fiction.
export function estimateCostMicros({ model = "", promptTokens = 0, completionTokens = 0 } = {}) {
  const price = modelPrice(model);
  if (!price) return null;
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  return Math.round(prompt * price.prompt + completion * price.completion);
}

// Infer a provider label from a model id when the reporter didn't name one.
export function providerForModel(model = "") {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return "";
  if (id.startsWith("claude")) return "anthropic";
  if (/^(gpt-|o[0-9])/.test(id)) return "openai";
  if (id.startsWith("gemini")) return "google";
  return "";
}
