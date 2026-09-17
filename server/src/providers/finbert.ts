// FinBERT sentiment analysis for financial news headlines.
// Uses Hugging Face Inference API (free tier) with the ProsusAI/finbert model.
// Falls back to keyword heuristic if API unavailable.
import { tracked } from "../providers/registry.js";

export type Sentiment = "bullish" | "bearish" | "neutral";

export interface SentimentResult {
  label: Sentiment;
  score: number; // 0-1 confidence
  raw: { label: string; score: number }[];
}

const HF_API = "https://api-inference.huggingface.co/models/ProsusAI/finbert";
const HF_TOKEN = process.env.HUGGINGFACE_API_KEY?.trim();

async function hfInference(texts: string[]): Promise<SentimentResult[]> {
  if (!HF_TOKEN) throw new Error("HUGGINGFACE_API_KEY not set");
  const res = await fetch(HF_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HF ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { label: string; score: number }[][];
  return data.map((arr) => {
    const top = arr.reduce((a, b) => (a.score > b.score ? a : b));
    const labelMap: Record<string, Sentiment> = {
      Positive: "bullish",
      Negative: "bearish",
      Neutral: "neutral",
    };
    return {
      label: labelMap[top.label] ?? "neutral",
      score: top.score,
      raw: arr,
    };
  });
}

// Lightweight keyword fallback (no external deps)
function keywordSentiment(text: string): SentimentResult {
  const t = text.toLowerCase();
  const bull = ["surge", "rally", "gain", "rise", "bullish", "beat", "above", "strong", "record", "high", "upgrade", "optimistic", "growth"];
  const bear = ["fall", "drop", "decline", "crash", "bearish", "miss", "below", "weak", "low", "downgrade", "pessimistic", "recession", "cut", "slump"];
  let score = 0;
  for (const w of bull) if (t.includes(w)) score += 1;
  for (const w of bear) if (t.includes(w)) score -= 1;
  const label: Sentiment = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  const confidence = Math.min(0.5 + Math.abs(score) * 0.1, 0.85);
  return { label, score: confidence, raw: [] };
}

/** Analyze sentiment for multiple headlines. Returns array aligned with input. */
export async function analyzeSentiment(headlines: string[]): Promise<SentimentResult[]> {
  if (headlines.length === 0) return [];
  try {
    return await tracked("finbert", () => hfInference(headlines));
  } catch (err) {
    console.warn("[finbert] HF inference failed, using keyword fallback:", err instanceof Error ? err.message : String(err));
    return headlines.map(keywordSentiment);
  }
}

/** Single-headline convenience. */
export async function analyzeOne(headline: string): Promise<SentimentResult> {
  const [res] = await analyzeSentiment([headline]);
  return res;
}