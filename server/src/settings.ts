import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runtime settings for the terminal, configurable from the Settings panel:
 *  - AI provider API keys (OpenRouter / Gemini / Groq / NVIDIA / Anthropic)
 *  - alert (sound) preferences and thresholds
 *  - realtime refresh intervals
 *  - AI provider fallback order
 * Persisted to DATA_DIR/settings.json; env vars act as defaults/overrides.
 * API keys are never returned to the UI — only masked presence flags.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");
mkdirSync(dataDir, { recursive: true });
const file = join(dataDir, "settings.json");

export const AI_PROVIDERS = ["openrouter", "gemini", "groq", "nvidia", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  groq: "Groq",
  nvidia: "NVIDIA NIM",
  anthropic: "Anthropic",
};

export const AI_PROVIDER_MODELS: Record<AiProvider, string> = {
  openrouter: "openrouter/free auto-route",
  gemini: "gemini-3-flash-preview",
  groq: "openai/gpt-oss-120b",
  nvidia: "nvidia/nemotron-3-super-120b-a12b",
  anthropic: "claude-3-5-sonnet-20241022",
};

/**
 * Ordered candidate models per provider — the LLM router tries them one by one
 * before giving up on a provider and falling through to the next one. All picked
 * from the currently available free tier (verified against live key endpoints).
 */
export const AI_PROVIDER_CHAIN: Record<AiProvider, string[]> = {
  openrouter: ["openrouter/free", "nex-agi/nex-n2.5-pro:free"],
  gemini: ["gemini-3-flash-preview", "gemini-3.8-flash"],
  groq: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
  nvidia: ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3-flash"],
  anthropic: ["claude-3-5-sonnet-20241022"],
};

export type PriceLevelAlert = {
  symbol: string;
  level: number;
  dir: "above" | "below";
  label?: string;
};

export type WebhookSettings = {
  enabled: boolean;
  url: string;
};

export type AlertSettings = {
  enabled: boolean;
  sound: boolean;
  thresholdPct: number;
  highImpact: boolean;
  display: "beep" | "tone";
  volume: number;
  levels: PriceLevelAlert[];
  /** Fire OS-level desktop notifications as well as the in-app banner. */
  notifications: boolean;
  /** Pre-event nudge: announce high-impact calendar events this many minutes out. */
  countdownMin: number;
  /** Fire an alert whenever a headline contains any of these keywords. */
  newsKeywords: string[];
  /** Optional webhook that receives alert payloads — lets alerts fire even when the app is closed. */
  webhook: WebhookSettings;
};

export type RefreshSettings = {
  quotes: number;
  charts: number;
  markets: number;
  news: number;
};

export type AppSettings = {
  refreshMs: RefreshSettings;
  alerts: AlertSettings;
  providerOrder: AiProvider[];
  apiKeys: Record<string, string>;
};

const DEFAULTS: AppSettings = {
  refreshMs: { quotes: 1_000, charts: 3_000, markets: 3_000, news: 30_000 },
  alerts: {
    enabled: true,
    sound: true,
    thresholdPct: 0.5,
    highImpact: true,
    display: "tone",
    volume: 0.15,
    levels: [],
    notifications: true,
    countdownMin: 15,
    newsKeywords: [],
    webhook: { enabled: false, url: "" },
  },
  providerOrder: [...AI_PROVIDERS],
  apiKeys: {},
};

let settings: AppSettings = load();

function load(): AppSettings {
  try {
    if (!existsSync(file)) return { ...DEFAULTS, apiKeys: {} };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const levels = Array.isArray(parsed.alerts?.levels)
      ? (parsed.alerts.levels as unknown[]).filter((l): l is PriceLevelAlert =>
          l != null && typeof l === "object" &&
          typeof (l as any).symbol === "string" &&
          typeof (l as any).level === "number" && Number.isFinite((l as any).level) &&
          ((l as any).dir === "above" || (l as any).dir === "below")
        )
      : [];
    const alerts = { ...DEFAULTS.alerts, ...(parsed.alerts ?? {}), levels };
    alerts.countdownMin = Number.isFinite(alerts.countdownMin) ? Math.min(120, Math.max(1, Math.round(alerts.countdownMin))) : DEFAULTS.alerts.countdownMin;
    alerts.notifications = alerts.notifications !== false;
    if (!Array.isArray(alerts.newsKeywords)) alerts.newsKeywords = [];
    alerts.newsKeywords = alerts.newsKeywords
      .map((k: unknown) => (typeof k === "string" ? k.trim() : ""))
      .filter((k: string) => k.length > 0)
      .slice(0, 20);
    const wh = (alerts.webhook ?? {}) as any;
    alerts.webhook = {
      enabled: wh.enabled === true,
      url: typeof wh.url === "string" ? wh.url.slice(0, 500) : "",
    };
    return {
      ...DEFAULTS,
      ...parsed,
      refreshMs: { ...DEFAULTS.refreshMs, ...(parsed.refreshMs ?? {}) },
      alerts,
      providerOrder: Array.isArray(parsed.providerOrder) ? parsed.providerOrder : [...AI_PROVIDERS],
      apiKeys: { ...(parsed.apiKeys ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, apiKeys: {} };
  }
}

function save(): void {
  try {
    writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[settings] failed to persist", err);
  }
}

export function getSettings(): AppSettings {
  return settings;
}

/** Get an API key for a provider: UI-configured key wins over env var. */
export function getAiKey(provider: AiProvider): string {
  const fromSettings = settings.apiKeys[provider]?.trim();
  if (fromSettings) return fromSettings;
  const env: Partial<Record<AiProvider, string | undefined>> = {
    openrouter: process.env.OPENROUTER_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    nvidia: process.env.NVIDIA_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  return env[provider]?.trim() ?? "";
}

export function hasAnyAiKey(): boolean {
  return AI_PROVIDERS.some((p) => getAiKey(p) !== "");
}

/** Configured AI providers, in the user's preferred order. */
export function aiProvidersWithKeys(): Array<{ provider: AiProvider; key: string; model: string }> {
  const order = settings.providerOrder.filter((p) => AI_PROVIDERS.includes(p));
  const unique = [...new Set([...order, ...AI_PROVIDERS])];
  const out: Array<{ provider: AiProvider; key: string; model: string }> = [];
  for (const provider of unique) {
    const key = getAiKey(provider);
    if (key) out.push({ provider, key, model: AI_PROVIDER_MODELS[provider] });
  }
  return out;
}

/** Safe view of the settings for the browser — keys are masked to presence only. */
export function publicSettings() {
  const keys: Record<string, boolean> = {};
  for (const p of AI_PROVIDERS) keys[p] = getAiKey(p) !== "";
  return {
    refreshMs: settings.refreshMs,
    alerts: settings.alerts,
    providerOrder: settings.providerOrder,
    providers: keys,
    aiConfigured: hasAnyAiKey(),
  };
}

export function setApiKey(provider: string, key: string): void {
  settings.apiKeys[provider] = key.trim();
  save();
}

export function patchSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  save();
}