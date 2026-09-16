import { Router } from "express";
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  aiProvidersWithKeys,
  getSettings,
  patchSettings,
  publicSettings,
  setApiKey,
  type AiProvider,
  type AppSettings,
} from "../settings.js";

export const settingsRouter = Router();

/** GET /api/settings – safe view (API keys masked to presence). */
settingsRouter.get("/", (_req, res) => {
  res.json(publicSettings());
});

/** GET /api/settings/providers – which provider would answer right now. */
settingsRouter.get("/providers", (_req, res) => {
  res.json({
    providers: aiProvidersWithKeys().map((c) => ({
      provider: c.provider,
      label: AI_PROVIDER_LABELS[c.provider],
      model: c.model,
    })),
  });
});

/**
 * POST /api/settings
 * Accepts partial patches: { apiKeys: { openrouter: "..." }, alerts: {...},
 * refreshMs: {...}, providerOrder: [...] }. Keys are stored server-side and
 * never echoed back. Passing a key clears it. Empty strings in apiKeys remove
 * the stored key.
 */
settingsRouter.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Partial<AppSettings> & { apiKeys?: Record<string, string> };
  try {
    const current = getSettings();

    if (body.apiKeys && typeof body.apiKeys === "object") {
      // Only the keys explicitly present in the request are touched.
      for (const provider of Object.keys(body.apiKeys)) {
        if (!AI_PROVIDERS.includes(provider as AiProvider)) continue;
        const value = String(body.apiKeys[provider] ?? "").trim();
        if (value === "") {
          // clear the stored key (env fallback remains active)
          if (current.apiKeys[provider]) {
            const next = { ...current.apiKeys };
            delete next[provider];
            patchSettings({ apiKeys: next });
          }
        } else {
          setApiKey(provider as AiProvider, value);
        }
      }
    }

    if (body.refreshMs && typeof body.refreshMs === "object") {
      const refreshMs = { ...current.refreshMs, ...body.refreshMs };
      refreshMs.quotes = clampInt(refreshMs.quotes, 500, 60_000);
      refreshMs.charts = clampInt(refreshMs.charts, 1_000, 120_000);
      refreshMs.markets = clampInt(refreshMs.markets, 1_000, 120_000);
      refreshMs.news = clampInt(refreshMs.news, 5_000, 600_000);
      patchSettings({ refreshMs });
    }

    if (body.alerts && typeof body.alerts === "object") {
      const a = body.alerts as Partial<AppSettings["alerts"]> & { levels?: unknown };
      const levels = Array.isArray(a.levels)
        ? a.levels
            .filter(
              (l): l is AppSettings["alerts"]["levels"][number] =>
                l != null && typeof l === "object" &&
                typeof (l as any).symbol === "string" &&
                typeof (l as any).level === "number" && Number.isFinite((l as any).level) &&
                ((l as any).dir === "above" || (l as any).dir === "below")
            )
            .map((l) => ({ symbol: (l as any).symbol.toUpperCase(), level: (l as any).level, dir: (l as any).dir, label: typeof (l as any).label === "string" ? (l as any).label : undefined }))
        : current.alerts.levels;
      const wh = a.webhook as Partial<AppSettings["alerts"]["webhook"]> | undefined;
      const existingWh = current.alerts.webhook ?? { enabled: false, url: "" };
      patchSettings({
        alerts: {
          ...current.alerts,
          ...a,
          levels,
          thresholdPct: clip(a.thresholdPct ?? current.alerts.thresholdPct, 0.05, 10),
          volume: clip(a.volume ?? current.alerts.volume, 0, 1),
          countdownMin: clampInt(a.countdownMin ?? current.alerts.countdownMin, 1, 120),
          notifications: a.notifications === undefined ? current.alerts.notifications : a.notifications === true,
          newsKeywords: Array.isArray(a.newsKeywords)
            ? a.newsKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim()).slice(0, 20)
            : current.alerts.newsKeywords,
          webhook: {
            enabled: wh?.enabled === true,
            url: typeof wh?.url === "string" ? wh.url.slice(0, 500) : existingWh.url,
          },
        },
      });
    }

    if (Array.isArray(body.providerOrder)) {
      const clean = body.providerOrder.filter((p): p is AiProvider => AI_PROVIDERS.includes(p as AiProvider));
      if (clean.length > 0) patchSettings({ providerOrder: clean });
    }

    res.json(publicSettings());
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/settings/test – test one provider key with a tiny round-trip. */
settingsRouter.post("/test", async (req, res) => {
  const { provider } = (req.body ?? {}) as { provider?: string };
  if (!provider || !AI_PROVIDERS.includes(provider as AiProvider)) {
    return res.status(400).json({ error: "invalid provider" });
  }
  try {
    const { chatWithFallback } = await import("../providers/llm.js");
    const msg = { role: "user" as const, content: "Reply with exactly: OK" };
    const result = await chatWithFallback([msg], getSettings());
    res.json({ ok: true, provider: result.provider, model: result.model, reply: result.text });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function clip(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}