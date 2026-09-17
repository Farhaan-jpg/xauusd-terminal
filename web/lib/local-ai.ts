// Local AI Manager — optimized for i3-12th gen / 8GB RAM / no GPU
// Uses llama.cpp server (bundled) with quantized models that fit in ~3GB total

export type LocalModelId =
  | "phi-3.5-mini"      // 3.8B, q4_k_m: 2.3GB — best reasoning/classification
  | "llama-3.2-3b"      // 3B, q4_k_m: 2.0GB — fast chat, multilingual
  | "qwen2.5-3b"        // 3B, q4_k_m: 2.0GB — best for Indian languages
  | "smollm2-1.7b"      // 1.7B, q4_k_m: 1.2GB — fastest, low memory
  | "nomic-embed-v1.5"; // 137M, q4_k_m: 0.1GB — embeddings (always loaded)

export interface ModelSpec {
  id: LocalModelId;
  filename: string;
  url: string;
  sizeGB: number;
  ramGB: number;      // RAM needed when loaded (model + context + overhead)
  capabilities: ModelCapability[];
  description: string;
}

export type ModelCapability =
  | "chat"
  | "classification"
  | "extraction"
  | "summarization"
  | "sentiment"
  | "embedding"
  | "indian-languages"
  | "function-calling"
  | "reasoning";

export const MODEL_SPECS: Record<LocalModelId, ModelSpec> = {
  "phi-3.5-mini": {
    id: "phi-3.5-mini",
    filename: "phi-3.5-mini-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/microsoft/Phi-3.5-mini-instruct-GGUF/resolve/main/phi-3.5-mini-instruct-q4_k_m.gguf",
    sizeGB: 2.3,
    ramGB: 3.0,
    capabilities: ["chat", "classification", "extraction", "summarization", "reasoning", "function-calling"],
    description: "Microsoft Phi-3.5 Mini — best overall reasoning for classification, extraction, function-calling",
  },
  "llama-3.2-3b": {
    id: "llama-3.2-3b",
    filename: "llama-3.2-3b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/llama-3.2-3b-instruct-q4_k_m.gguf",
    sizeGB: 2.0,
    ramGB: 2.7,
    capabilities: ["chat", "classification", "extraction", "summarization", "indian-languages"],
    description: "Meta Llama 3.2 3B — fast, good multilingual support",
  },
  "qwen2.5-3b": {
    id: "qwen2.5-3b",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    sizeGB: 2.0,
    ramGB: 2.7,
    capabilities: ["chat", "classification", "extraction", "indian-languages", "reasoning"],
    description: "Alibaba Qwen 2.5 3B — best for Hindi/Tamil/Telugu/other Indian languages",
  },
  "smollm2-1.7b": {
    id: "smollm2-1.7b",
    filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
    sizeGB: 1.2,
    ramGB: 1.8,
    capabilities: ["chat", "classification", "extraction", "summarization"],
    description: "HuggingFace SmolLM2 1.7B — fastest, lowest memory, good for simple tasks",
  },
  "nomic-embed-v1.5": {
    id: "nomic-embed-v1.5",
    filename: "nomic-embed-text-v1.5-q4_k_m.gguf",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5-q4_k_m.gguf",
    sizeGB: 0.1,
    ramGB: 0.3,
    capabilities: ["embedding"],
    description: "Nomic Embed v1.5 — semantic search, RAG, clustering (always loaded)",
  },
};

// Recommended combo for 8GB: embeddings (0.3GB) + one LLM (2.7GB) = ~3GB total
// Leaves ~5GB for OS + Electron + browser + data
export const RECOMMENDED_COMBOS: LocalModelId[][] = [
  ["nomic-embed-v1.5", "phi-3.5-mini"],      // Best reasoning + embeddings (3.3GB)
  ["nomic-embed-v1.5", "qwen2.5-3b"],        // Best Indian languages + embeddings (3.0GB)
  ["nomic-embed-v1.5", "llama-3.2-3b"],      // Balanced + embeddings (3.0GB)
  ["nomic-embed-v1.5", "smollm2-1.7b"],      // Ultra-light (2.1GB) — for very tight memory
];

// Agent definitions — each maps to a capability and preferred model
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  capability: ModelCapability;
  preferredModels: LocalModelId[];
  systemPrompt: string;
  inputSchema: Record<string, unknown>; // JSON schema for structured input
  outputSchema: Record<string, unknown>; // JSON schema for structured output
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

// Market-specific agents for the terminal
export const AGENTS: AgentDefinition[] = [
  {
    id: "market-classifier",
    name: "Market Regime Classifier",
    description: "Classifies current market regime: trending/range/volatile + bullish/bearish/neutral",
    capability: "classification",
    preferredModels: ["phi-3.5-mini", "qwen2.5-3b"],
    systemPrompt: `You are a market regime classifier for gold (XAUUSD). 
Analyze the provided market data (price, indicators, macro, news sentiment) and output ONLY valid JSON:
{
  "regime": "trending_up" | "trending_down" | "ranging" | "volatile",
  "trend_strength": 0-100,
  "bias": "bullish" | "bearish" | "neutral",
  "confidence": 0-100,
  "key_factors": ["factor1", "factor2"],
  "timeframe": "scalp" | "intraday" | "swing" | "position"
}`,
    inputSchema: {
      type: "object",
      properties: {
        price: { type: "number" },
        changePercent: { type: "number" },
        rsi: { type: "number" },
        macd: { type: "object" },
        adx: { type: "number" },
        dxy: { type: "number" },
        yields: { type: "number" },
        newsSentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
        vix: { type: "number" },
      },
      required: ["price", "changePercent"],
    },
    outputSchema: {
      type: "object",
      properties: {
        regime: { type: "string", enum: ["trending_up", "trending_down", "ranging", "volatile"] },
        trend_strength: { type: "number", minimum: 0, maximum: 100 },
        bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
        confidence: { type: "number", minimum: 0, maximum: 100 },
        key_factors: { type: "array", items: { type: "string" } },
        timeframe: { type: "string", enum: ["scalp", "intraday", "swing", "position"] },
      },
      required: ["regime", "trend_strength", "bias", "confidence", "timeframe"],
    },
    timeoutMs: 8000,
    maxTokens: 256,
    temperature: 0.1,
  },
  {
    id: "news-sentiment",
    name: "Financial News Sentiment",
    description: "Deep sentiment analysis of headlines with gold-specific context",
    capability: "sentiment",
    preferredModels: ["phi-3.5-mini", "qwen2.5-3b"],
    systemPrompt: `You are a gold-market news sentiment analyzer. 
For each headline, output ONLY valid JSON:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "confidence": 0-100,
  "impact": "high" | "medium" | "low",
  "themes": ["theme1", "theme2"],
  "gold_relevance": 0-100,
  "time_horizon": "immediate" | "session" | "days" | "weeks"
}`,
    inputSchema: {
      type: "object",
      properties: {
        headline: { type: "string" },
        source: { type: "string" },
        publishedAt: { type: "string" },
      },
      required: ["headline"],
    },
    outputSchema: {
      type: "object",
      properties: {
        sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
        confidence: { type: "number", minimum: 0, maximum: 100 },
        impact: { type: "string", enum: ["high", "medium", "low"] },
        themes: { type: "array", items: { type: "string" } },
        gold_relevance: { type: "number", minimum: 0, maximum: 100 },
        time_horizon: { type: "string", enum: ["immediate", "session", "days", "weeks"] },
      },
      required: ["sentiment", "confidence", "impact", "gold_relevance", "time_horizon"],
    },
    timeoutMs: 5000,
    maxTokens: 192,
    temperature: 0.1,
  },
  {
    id: "macro-extractor",
    name: "Macro Data Extractor",
    description: "Extracts structured macro events from Fed speeches, CPI reports, central bank minutes",
    capability: "extraction",
    preferredModels: ["phi-3.5-mini", "qwen2.5-3b"],
    systemPrompt: `Extract key macro signals from text. Output ONLY valid JSON:
{
  "events": [
    {
      "type": "fed_speech" | "cpi" | "pce" | "nfp" | "gdp" | "central_bank" | "geopolitical",
      "signal": "hawkish" | "dovish" | "neutral",
      "magnitude": 0-100,
      "key_quote": "exact phrase",
      "gold_implication": "bullish" | "bearish" | "neutral"
    }
  ],
  "overall_bias": "hawkish" | "dovish" | "mixed" | "neutral",
  "confidence": 0-100
}`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        source: { type: "string" },
      },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              signal: { type: "string", enum: ["hawkish", "dovish", "neutral"] },
              magnitude: { type: "number", minimum: 0, maximum: 100 },
              key_quote: { type: "string" },
              gold_implication: { type: "string", enum: ["bullish", "bearish", "neutral"] },
            },
            required: ["type", "signal", "magnitude", "gold_implication"],
          },
        },
        overall_bias: { type: "string", enum: ["hawkish", "dovish", "mixed", "neutral"] },
        confidence: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["events", "overall_bias", "confidence"],
    },
    timeoutMs: 10000,
    maxTokens: 384,
    temperature: 0.1,
  },
  {
    id: "chart-pattern",
    name: "Chart Pattern Recognition",
    description: "Identifies patterns from OHLCV data: H&S, double top/bottom, flags, wedges, Wyckoff",
    capability: "classification",
    preferredModels: ["phi-3.5-mini", "llama-3.2-3b"],
    systemPrompt: `Analyze OHLCV data for chart patterns. Output ONLY valid JSON:
{
  "patterns": [
    {
      "name": "head_and_shoulders" | "inverse_hs" | "double_top" | "double_bottom" | "bull_flag" | "bear_flag" | "rising_wedge" | "falling_wedge" | "triangle" | "rectangle" | "wyckoff_accumulation" | "wyckoff_distribution",
      "status": "forming" | "confirmed" | "failed" | "target_reached",
      "confidence": 0-100,
      "entry_zone": [low, high],
      "stop_loss": number,
      "targets": [number],
      "timeframe": "5m" | "15m" | "1h" | "4h" | "1d"
    }
  ],
  "trend": "up" | "down" | "sideways",
  "support_levels": [number],
  "resistance_levels": [number],
}`,
    inputSchema: {
      type: "object",
      properties: {
        ohlcv: {
          type: "array",
          items: {
            type: "object",
            properties: {
              t: { type: "number" },
              o: { type: "number" },
              h: { type: "number" },
              l: { type: "number" },
              c: { type: "number" },
              v: { type: "number" },
            },
            required: ["t", "o", "h", "l", "c", "v"],
          },
        },
        timeframe: { type: "string" },
      },
      required: ["ohlcv", "timeframe"],
    },
    outputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["forming", "confirmed", "failed", "target_reached"] },
              confidence: { type: "number", minimum: 0, maximum: 100 },
              entry_zone: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
              stop_loss: { type: "number" },
              targets: { type: "array", items: { type: "number" } },
              timeframe: { type: "string" },
            },
            required: ["name", "status", "confidence", "entry_zone", "stop_loss", "targets", "timeframe"],
          },
        },
        trend: { type: "string", enum: ["up", "down", "sideways"] },
        support_levels: { type: "array", items: { type: "number" } },
        resistance_levels: { type: "array", items: { type: "number" } },
      },
      required: ["patterns", "trend", "support_levels", "resistance_levels"],
    },
    timeoutMs: 12000,
    maxTokens: 512,
    temperature: 0.1,
  },
  {
    id: "risk-manager",
    name: "Position Risk Manager",
    description: "Calculates position size, stop loss, R:R, portfolio heat from account equity + setup",
    capability: "reasoning",
    preferredModels: ["phi-3.5-mini", "qwen2.5-3b"],
    systemPrompt: `You are a risk manager for gold trading. Given account equity, setup, and market context, output ONLY valid JSON:
{
  "position_size_lots": number,
  "position_value_usd": number,
  "risk_usd": number,
  "risk_pct": number,
  "stop_loss": number,
  "take_profit_1": number,
  "take_profit_2": number,
  "take_profit_3": number,
  "rr_ratio": number,
  "max_portfolio_heat": number,
  "scaling_plan": [
    { "level": number, "size_pct": number, "action": "add" | "reduce" }
  ],
  "warnings": ["warning1"],
}`,
    inputSchema: {
      type: "object",
      properties: {
        equity_usd: { type: "number" },
        entry_price: { type: "number" },
        setup_type: { type: "string" },
        stop_loss_price: { type: "number" },
        target_prices: { type: "array", items: { type: "number" } },
        volatility_atr: { type: "number" },
        current_exposure_pct: { type: "number" },
        max_risk_per_trade_pct: { type: "number" },
        max_portfolio_heat_pct: { type: "number" },
      },
      required: ["equity_usd", "entry_price", "stop_loss_price", "target_prices"],
    },
    outputSchema: {
      type: "object",
      properties: {
        position_size_lots: { type: "number" },
        position_value_usd: { type: "number" },
        risk_usd: { type: "number" },
        risk_pct: { type: "number" },
        stop_loss: { type: "number" },
        take_profit_1: { type: "number" },
        take_profit_2: { type: "number" },
        take_profit_3: { type: "number" },
        rr_ratio: { type: "number" },
        max_portfolio_heat: { type: "number" },
        scaling_plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              level: { type: "number" },
              size_pct: { type: "number" },
              action: { type: "string", enum: ["add", "reduce"] },
            },
            required: ["level", "size_pct", "action"],
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["position_size_lots", "risk_usd", "risk_pct", "rr_ratio", "warnings"],
    },
    timeoutMs: 8000,
    maxTokens: 384,
    temperature: 0.1,
  },
  {
    id: "indian-market-brief",
    name: "Indian Market Brief Generator",
    description: "Generates Hindi/English/Tamil market briefs for Indian traders — MCX gold, rupee impact, festival seasonality",
    capability: "chat",
    preferredModels: ["qwen2.5-3b", "phi-3.5-mini"],
    systemPrompt: `You are an Indian gold market analyst. Generate a concise brief in the requested language.
Cover: MCX gold futures, INR/USD impact, RBI policy, festival/wedding seasonality, import duty, digital gold, sovereign gold bonds.
Output ONLY valid JSON:
{
  "language": "en" | "hi" | "ta" | "te" | "mr" | "gu" | "bn" | "kn" | "ml" | "pa" | "or" | "as",
  "brief": "2-3 paragraph market brief",
  "key_levels": { "mcx_support": number, "mcx_resistance": number, "spot_support": number, "spot_resistance": number },
  "action_items": ["item1", "item2"],
  "risk_events": ["event1"],
}`,
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string" },
        mcx_price: { type: "number" },
        spot_price: { type: "number" },
        usdinr: { type: "number" },
        rbi_policy: { type: "string" },
        import_duty: { type: "number" },
        festival_season: { type: "boolean" },
      },
      required: ["language", "mcx_price", "spot_price", "usdinr"],
    },
    outputSchema: {
      type: "object",
      properties: {
        language: { type: "string" },
        brief: { type: "string" },
        key_levels: {
          type: "object",
          properties: {
            mcx_support: { type: "number" },
            mcx_resistance: { type: "number" },
            spot_support: { type: "number" },
            spot_resistance: { type: "number" },
          },
          required: ["mcx_support", "mcx_resistance", "spot_support", "spot_resistance"],
        },
        action_items: { type: "array", items: { type: "string" } },
        risk_events: { type: "array", items: { type: "string" } },
      },
      required: ["language", "brief", "key_levels", "action_items", "risk_events"],
    },
    timeoutMs: 10000,
    maxTokens: 512,
    temperature: 0.3,
  },
];

// Model loading strategy for 8GB RAM
export function getOptimalModelSet(availableRamGB: number = 8): LocalModelId[] {
  // Reserve 4GB for OS + Electron + browser overhead
  const usableRam = Math.max(0, availableRamGB - 4);
  
  if (usableRam >= 3.5) return ["nomic-embed-v1.5", "phi-3.5-mini"];
  if (usableRam >= 3.0) return ["nomic-embed-v1.5", "qwen2.5-3b"];
  if (usableRam >= 2.5) return ["nomic-embed-v1.5", "llama-3.2-3b"];
  return ["nomic-embed-v1.5", "smollm2-1.7b"];
}

export function estimateTotalRam(models: LocalModelId[]): number {
  return models.reduce((sum, m) => sum + MODEL_SPECS[m].ramGB, 0);
}

export function canRunModels(models: LocalModelId[], availableRamGB: number = 8): boolean {
  const needed = estimateTotalRam(models) + 4; // +4GB system overhead
  return needed <= availableRamGB;
}