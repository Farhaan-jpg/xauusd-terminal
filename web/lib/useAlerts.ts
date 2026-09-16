"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, type NewsItem, type Quote } from "../lib/api";
import { playAlertSound } from "../lib/sounds";
import { osNotify, pushTray } from "../lib/notify";
import { GOLD_SYMBOL, useTerminal } from "../store/terminal";

type EconEvent = {
  title: string;
  country: string;
  date: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
};

export type AlertBanner = { key: number; text: string; tone: "up" | "down" | "amber" };

const fmtTick = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/**
 * Watches the live spot quote, the economic calendar and the geopolitics feed
 * and fires alerts (banner + WebAudio beep) when:
 *  - gold makes a move >= thresholdPct between two polls, or
 *  - a High-impact calendar event's time reaches "now", or
 *  - a High-impact geopolitical headline breaks in the news feed.
 * Configuration comes from server settings; see /api/settings.
 */
export function useAlerts(): AlertBanner | null {
  const settings = useTerminal((s) => s.settings);
  const cfg = settings?.alerts;
  const alertsOn = cfg?.enabled ?? false;

  const [banner, setBanner] = useState<AlertBanner | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const firedEventsRef = useRef(new Set<string>());
  const seenNewsRef = useRef(new Set<string>());
  const seededNewsRef = useRef(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bannerKey = useRef(0);

  const pollMs = Math.max(settings?.refreshMs?.quotes ?? 2_000, 1_000);

  const { data: spot } = useQuery({
    queryKey: ["alerts-spot", GOLD_SYMBOL],
    enabled: alertsOn,
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${GOLD_SYMBOL}`))[0],
    refetchInterval: pollMs,
  });

  // User-defined trigger levels: fire when a symbol's price crosses a level.
  const levelSymbols = useMemo(
    () => [...new Set((cfg?.levels ?? []).map((l) => l.symbol.toUpperCase()).filter(Boolean))],
    [cfg?.levels]
  );

  const { data: levelQuotes } = useQuery({
    queryKey: ["alerts-levels", levelSymbols.join(",")],
    enabled: alertsOn && levelSymbols.length > 0,
    queryFn: async () => apiGet<Quote[]>(`/api/quotes?symbols=${levelSymbols.join(",")}`),
    refetchInterval: pollMs,
  });

  const firedLevelsRef = useRef(new Set<string>());

  const { data: events } = useQuery({
    queryKey: ["alerts-calendar"],
    enabled: alertsOn && (cfg?.highImpact ?? false),
    queryFn: () => apiGet<EconEvent[]>("/api/econ-calendar"),
    refetchInterval: 60_000,
  });

  // Geopolitics / breaking news — every New York trading minute gold reacts to
  // wars, missile strikes, sanctions and coups long before any data release.
  const { data: geo } = useQuery({
    queryKey: ["alerts-geo"],
    enabled: alertsOn && (cfg?.highImpact ?? false),
    queryFn: () => apiGet<NewsItem[]>("/api/news/geopolitics"),
    refetchInterval: 60_000,
  });

  // General gold headlines — for user-configured keyword alerts (e.g. "cpi").
  const kwEnabled = alertsOn && (cfg?.newsKeywords?.length ?? 0) > 0;
  const { data: kwNews } = useQuery({
    queryKey: ["alerts-kw-news"],
    enabled: kwEnabled,
    queryFn: () => apiGet<NewsItem[]>("/api/news"),
    refetchInterval: 60_000,
  });

  const show = useCallback((text: string, tone: AlertBanner["tone"]) => {
    bannerKey.current += 1;
    setBanner({ key: bannerKey.current, text, tone });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), 6_000);
    // In-app tray entry + OS desktop notification (when enabled/permitted).
    pushTray(text, tone);
    const alertsNow = useTerminal.getState().settings?.alerts;
    if (alertsNow?.notifications !== false) osNotify("XAUUSD Alert", text);
  }, []);

  // Price-level triggers: fire once when crossed, then re-arm when price
  // retreats past the level on the far side.
  useEffect(() => {
    if (!alertsOn || !levelQuotes) return;
    const bySym = new Map(levelQuotes.map((q) => [q.symbol.toUpperCase(), q.price]));
    for (const l of cfg?.levels ?? []) {
      const price = bySym.get(l.symbol.toUpperCase());
      if (price === undefined || price === null) continue;
      const key = `${l.symbol.toUpperCase()}|${l.level}|${l.dir}`;
      const hit = l.dir === "above" ? price >= l.level : price <= l.level;
      if (hit && !firedLevelsRef.current.has(key)) {
        firedLevelsRef.current.add(key);
        if (cfg?.sound) playAlertSound(cfg.volume ?? 0.5);
        show(
          `${l.symbol.toUpperCase()} ${fmtTick(l.level)} ${l.dir === "above" ? "BREACHED ▲" : "BROKEN ▼"} @ ${fmtTick(price)}`,
          l.dir === "above" ? "up" : "down"
        );
      } else if (!hit) {
        // arm (or re-arm) while price sits on the safe side of the level
        firedLevelsRef.current.delete(key);
      }
    }
  }, [levelQuotes, alertsOn, cfg, show]);

  // Spot move threshold (percent between consecutive polls).
  useEffect(() => {
    if (!alertsOn || !spot?.price) return;
    const prev = lastPriceRef.current;
    lastPriceRef.current = spot.price;
    if (prev === null) return;
    const threshold = cfg?.thresholdPct ?? 0.5;
    const changePct = (Math.abs(spot.price - prev) / prev) * 100;
    if (changePct >= threshold) {
      const delta = spot.price - prev;
      if (cfg?.sound) playAlertSound(cfg.volume ?? 0.5);
      show(`GOLD ${delta >= 0 ? "▲" : "▼"} ${fmtTick(delta)} (${delta >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`, delta >= 0 ? "up" : "down");
    }
  }, [spot, alertsOn, cfg, show]);

  // High-impact calendar events as they hit "now".
  useEffect(() => {
    if (!alertsOn || !events) return;
    const now = Date.now();
    const windowStart = now - 2 * 60_000;
    const windowEnd = now + 30_000;
    for (const e of events) {
      if (e.impact !== "High") continue;
      const t = new Date(e.date).getTime();
      if (Number.isNaN(t) || t < windowStart || t > windowEnd) continue;
      const key = `${e.country}-${e.title}-${e.date}`;
      if (firedEventsRef.current.has(key)) continue;
      firedEventsRef.current.add(key);
      if (cfg?.sound) playAlertSound(cfg.volume ?? 0.5);
      show(`${e.country} ${e.title.replace(/\s+/g, " ").toUpperCase()}`, "amber");
    }
  }, [events, alertsOn, cfg, show]);

  // Pre-release countdown: high/medium-impact events due within the configured
  // window announce themselves so you can be at the screen before the print.
  useEffect(() => {
    if (!alertsOn || !events || !(cfg?.highImpact ?? false)) return;
    const windowMin = cfg?.countdownMin ?? 0;
    if (!(windowMin > 0)) return;
    const now = Date.now();
    const windowMs = windowMin * 60_000;
    for (const e of events) {
      if (e.impact !== "High" && e.impact !== "Medium") continue;
      const t = new Date(e.date).getTime();
      if (Number.isNaN(t)) continue;
      const until = t - now;
      if (until <= 0 || until > windowMs) continue;
      const key = `cd-${e.country}-${e.title}-${e.date}`;
      if (firedEventsRef.current.has(key)) continue;
      firedEventsRef.current.add(key);
      const mins = Math.max(1, Math.ceil(until / 60_000));
      if (cfg?.sound) playAlertSound(cfg.volume ?? 0.5);
      show(`COUNTDOWN · ${e.country} ${e.title.replace(/\s+/g, " ")} in ~${mins}m`, "amber");
    }
  }, [events, alertsOn, cfg, show]);

  // User-defined news keywords — fire when a fresh headline mentions one.
  const kwSeenRef = useRef(new Set<string>());
  const kwSeededRef = useRef(false);
  useEffect(() => {
    if (!alertsOn || !kwNews) return;
    const keywords = (cfg?.newsKeywords ?? []).map((k) => k.toLowerCase()).filter((k) => k.length > 0);
    if (keywords.length === 0) return;
    if (!kwSeededRef.current) {
      for (const n of kwNews) kwSeenRef.current.add(n.title);
      kwSeededRef.current = true;
      return;
    }
    for (const n of kwNews) {
      if (n.title.length === 0 || kwSeenRef.current.has(n.title)) continue;
      kwSeenRef.current.add(n.title);
      const hit = keywords.find((k) => n.title.toLowerCase().includes(k));
      if (!hit) continue;
      if (cfg?.sound) playAlertSound(cfg.volume ?? 0.5);
      show(`KEYWORD · ${n.title.replace(/\s+/g, " ").slice(0, 90)}`, "amber");
      break; // one headline per poll keeps the terminal calm
    }
  }, [kwNews, alertsOn, cfg, show]);

  // Breaking geopolitical headlines (High impact, only ones younger than 30m).
  useEffect(() => {
    if (!alertsOn || !geo || !cfg?.highImpact) return;
    // Seed the "seen" set silently on the first poll so we never fire on history.
    if (!seededNewsRef.current) {
      for (const n of geo) seenNewsRef.current.add(n.title);
      seededNewsRef.current = true;
      return;
    }
    const now = Date.now();
    for (const n of geo) {
      if (n.impact !== "High") continue;
      if (seenNewsRef.current.has(n.title)) continue;
      seenNewsRef.current.add(n.title);
      const publishedAgo = n.publishedAt ? now - new Date(n.publishedAt).getTime() : 0;
      if (publishedAgo > 30 * 60_000) continue; // stale headline recycled in the feed
      if (cfg.sound) playAlertSound(cfg.volume ?? 0.5);
      show(`GEO RISK · ${n.title.replace(/\s+/g, " ").slice(0, 90)}`, "amber");
      break; // one headline per poll keeps the terminal calm
    }
  }, [geo, alertsOn, cfg, show]);

  useEffect(() => {
    return () => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, []);

  return banner;
}