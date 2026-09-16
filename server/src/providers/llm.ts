/**
 * Multi-provider LLM router for the AI analyst with two-level automatic fallback:
 *  1. within a provider — its ordered candidate models are tried one by one
 *  2. across providers — the next configured provider is tried if one fails
 * Providers (in the user-configurable order) — all usable with *free* keys:
 *   OpenRouter  – `openrouter/free` auto-routes to the best available free model
 *   Google Gemini – free-tier API key (AI Studio), gemini-3-flash-preview
 *   Groq        – OpenAI-compatible free tier, openai/gpt-oss-120b
 *   NVIDIA NIM  – OpenAI-compatible, free "integrate.api" developer tier
 *   Anthropic   – optional (OpenAI/SDK), used as a final fallback
 * The chain of candidate models per provider lives in AI_PROVIDER_CHAIN (settings.ts).
 * The system prompt is identical across providers; a failing model/provider is
 * skipped, so a hard failure anywhere never blocks the analyst as long as
 * another configured provider/model answers.
 */

import { AI_PROVIDER_CHAIN, AI_PROVIDERS, aiProvidersWithKeys, getAiKey, type AiProvider, type AppSettings } from "../settings.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type LlmResult = { text: string; provider: AiProvider; model: string };

const SYSTEM = `You are the AI analyst inside a gold (XAUUSD) trading terminal.
You help the user interpret gold spot price action, charts, technical indicators, pivot levels,
news, geopolitical events, the US dollar index, Treasury yields (nominal and real), inflation
expectations, VIX and the economic calendar — all the drivers that move gold.
Answer concisely and professionally, in the language the user writes in.
When market data is provided in the conversation as JSON context, ground your answer in it.
You are not a licensed financial advisor: never give personalized investment advice or tell the
user what to buy or sell.`;

const timeout = (ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("LLM request timed out")), ms));

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const res = await Promise.race([fetch(url, init), timeout(60_000)]);
  if (!res.ok) {
    // include a snippet of the body for debugging provider issues
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

function openAiMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  return [{ role: "system", content: SYSTEM }, ...apiMessages];
}

/** Generic OpenAI-compatible chat completion; returns the text + resolved model. */
async function chatOpenAiCompatible(
  base: string,
  model: string,
  key: string,
  messages: ChatMessage[],
  extraHeaders: Record<string, string> = {}
): Promise<{ text: string; model: string }> {
  const json = await jsonFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: openAiMessages(messages),
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  const text: string | undefined = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`empty response from ${model}`);
  // openrouter/free reports the real model it routed to in json.model.
  const resolved: string =
    typeof json?.model === "string" && !json.model.includes(":free") && !json.model.startsWith("openrouter/")
      ? json.model
      : model;
  return { text, model: resolved };
}

/** Try an OpenAI-compatible provider across its candidate chain. */
async function openRouter(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const key = getAiKey("openrouter");
  const models = AI_PROVIDER_CHAIN.openrouter;
  const errors: string[] = [];
  for (const model of models) {
    try {
      return await chatOpenAiCompatible("https://openrouter.ai/api/v1", model, key, messages, {
        "HTTP-Referer": "https://localhost:3000",
        "X-Title": "XAUUSD Terminal",
      });
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`OpenRouter — ${errors.join(" | ")}`);
}

async function groq(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const key = getAiKey("groq");
  const models = AI_PROVIDER_CHAIN.groq;
  const errors: string[] = [];
  for (const model of models) {
    try {
      return await chatOpenAiCompatible("https://api.groq.com/openai/v1", model, key, messages);
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Groq — ${errors.join(" | ")}`);
}

async function nvidia(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const key = getAiKey("nvidia");
  const models = AI_PROVIDER_CHAIN.nvidia;
  const errors: string[] = [];
  for (const model of models) {
    try {
      return await chatOpenAiCompatible("https://integrate.api.nvidia.com/v1", model, key, messages);
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`NVIDIA — ${errors.join(" | ")}`);
}

async function gemini(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const key = getAiKey("gemini");
  const models = AI_PROVIDER_CHAIN.gemini;
  const errors: string[] = [];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const json = await jsonFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      });
      const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error("empty response");
      return { text, model };
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Gemini — ${errors.join(" | ")}`);
}

async function anthropic(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const key = getAiKey("anthropic");
  const model = AI_PROVIDER_CHAIN.anthropic[0];
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    messages,
  });
  if (response.stop_reason === "refusal") throw new Error("refusal");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("empty response from claude");
  return { text, model: "claude-3-5-sonnet" };
}

const CALLERS: Record<AiProvider, (messages: ChatMessage[]) => Promise<{ text: string; model: string }>> = {
  openrouter: openRouter,
  groq,
  nvidia,
  gemini,
  anthropic,
};

/** Run the analyst request across configured providers, returning the first success. */
export async function chatWithFallback(messages: ChatMessage[], settings: AppSettings): Promise<LlmResult> {
  const configured = aiProvidersWithKeys();
  if (configured.length === 0) {
    throw new Error("No AI provider configured. Add an API key (OpenRouter, Gemini, Groq or NVIDIA) in Settings.");
  }

  // Order: user preference first, then remaining default order.
  const order = [...settings.providerOrder, ...AI_PROVIDERS].filter(
    (p, i, a) => a.indexOf(p) === i && configured.some((c) => c.provider === p)
  );

  const errors: string[] = [];
  for (const provider of order) {
    try {
      const { text, model } = await CALLERS[provider](messages);
      return { text, provider, model };
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All AI providers failed — ${errors.join(" | ")}`);
}