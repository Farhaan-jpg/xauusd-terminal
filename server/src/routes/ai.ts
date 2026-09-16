import { Router } from "express";
import { chatWithFallback } from "../providers/llm.js";
import { getSettings } from "../settings.js";

export const aiRouter = Router();

const SYSTEM = `You are the AI analyst inside a gold (XAUUSD) trading terminal.
You help the user interpret gold spot price action, charts, technical indicators, pivot levels,
news, geopolitical events, the US dollar index, Treasury yields (nominal and real), inflation
expectations, VIX and the economic calendar — all the drivers that move gold.
Answer concisely and professionally, in the language the user writes in.
When market data is provided in the conversation as JSON context, ground your answer in it.
You are not a licensed financial advisor: never give personalized investment advice or tell the user what to buy or sell.`;

aiRouter.post("/chat", async (req, res) => {
  const { messages, context } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  try {
    const contextBlock = context
      ? [{ role: "user" as const, content: `Current terminal context (JSON):\n${JSON.stringify(context)}` }]
      : [];
    const result = await chatWithFallback([...contextBlock, ...messages], getSettings());
    res.json({ text: result.text, provider: result.provider, model: result.model });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
});