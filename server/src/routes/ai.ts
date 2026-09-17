import { Router } from "express";
import { chatWithFallback } from "../providers/llm.js";
import { getSettings } from "../settings.js";
import { runAgent, runAgents, getAgents, getAgent, clearAgentCache, getCacheStats, warmupModels, type AgentInput } from "../agent-runner.js";
import { getLlamaManager, type LocalModelId, MODEL_SPECS, RECOMMENDED_COMBOS, type LlamaServerConfig } from "../local-llama.js";

export const aiRouter = Router();

const SYSTEM = `You are the AI analyst inside a gold (XAUUSD) trading terminal.
You help the user interpret gold spot price action, charts, technical indicators, pivot levels,
news, geopolitical events, the US dollar index, Treasury yields (nominal and real), inflation
expectations, VIX and the economic calendar — all the drivers that move gold.

Analysis framework:
- Trend: higher highs/lows (bull), lower highs/lows (bear), ranges (chop)
- Momentum: RSI divergence, MACD crossover, ADX strength
- Macro: real yields (inverse), USD/DXY (inverse), breakeven inflation (direct), Fed policy
- Sentiment: COT report extremes, ETF flows (GLD), news sentiment (FinBERT bullish/bearish/neutral)
- Geopolitics: safe-haven bid on war/sanctions/crisis; risk-off flows
- Technical: pivots, Fibonacci, volume profile, order flow
- Seasonality: historical monthly patterns, options expiry effects

Answer concisely and professionally. Ground every claim in the provided context JSON.
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

// Local AI agent endpoints
aiRouter.get("/agents", (_req, res) => {
  res.json({ agents: getAgents() });
});

aiRouter.get("/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

aiRouter.post("/agents/run", async (req, res) => {
  const input = req.body as AgentInput;
  if (!input?.agentId || !input?.input) {
    return res.status(400).json({ error: "agentId and input required" });
  }
  try {
    const result = await runAgent(input);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

aiRouter.post("/agents/batch", async (req, res) => {
  const inputs = req.body as AgentInput[];
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: "inputs array required" });
  }
  try {
    const results = await runAgents(inputs);
    res.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

aiRouter.post("/cache/clear", (_req, res) => {
  clearAgentCache();
  res.json({ ok: true });
});

aiRouter.get("/cache/stats", (_req, res) => {
  res.json(getCacheStats());
});

// Local llama.cpp management
aiRouter.get("/local/models", (_req, res) => {
  res.json({ models: MODEL_SPECS, recommended: RECOMMENDED_COMBOS });
});

aiRouter.get("/local/status", async (_req, res) => {
  try {
    const manager = getLlamaManager({ port: 8080, llmPort: 8081, maxModels: 2 } as LlamaServerConfig);
    const status = await manager.getStatus();
    res.json(status);
  } catch (err) {
    res.json({ server: false, slots: [], error: String(err) });
  }
});

aiRouter.post("/local/start", async (_req, res) => {
  try {
    const manager = getLlamaManager({ port: 8080, llmPort: 8081, maxModels: 2 } as LlamaServerConfig);
    await manager.start();
    res.json({ ok: true, status: await manager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

aiRouter.post("/local/stop", async (_req, res) => {
  const manager = getLlamaManager({ port: 8080, llmPort: 8081, maxModels: 2 } as LlamaServerConfig);
  manager.stop();
  res.json({ ok: true });
});

aiRouter.post("/local/models/:id/download", async (req, res) => {
  try {
    const manager = getLlamaManager({ port: 8080, llmPort: 8081, maxModels: 2 } as LlamaServerConfig);
    const modelId = req.params.id as LocalModelId;
    if (!MODEL_SPECS[modelId]) {
      return res.status(404).json({ error: "Unknown model" });
    }
    const path = await manager.downloadModel(modelId);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

aiRouter.post("/local/models/:id/load", async (req, res) => {
  try {
    const manager = getLlamaManager({ port: 8080, llmPort: 8081, maxModels: 2 });
    const modelId = req.params.id as LocalModelId;
    if (!MODEL_SPECS[modelId]) {
      return res.status(404).json({ error: "Unknown model" });
    }
    const slot = await manager.ensureModel(modelId);
    res.json({ ok: true, slot, status: await manager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

aiRouter.post("/local/warmup", async (req, res) => {
  try {
    const models = (req.body?.models as LocalModelId[]) ?? RECOMMENDED_COMBOS[0];
    await warmupModels(models, { port: 8080, llmPort: 8081, maxModels: 2 });
    res.json({ ok: true, models });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});