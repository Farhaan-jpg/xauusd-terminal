"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, type NewsItem } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

const SENT: Record<string, { cls: string; mark: string; label: string }> = {
  bullish: { cls: "up", mark: "▲", label: "bullish" },
  bearish: { cls: "down", mark: "▼", label: "bearish" },
  neutral: { cls: "dim", mark: "•", label: "neutral" },
};

export default function NewsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [mode, setMode] = useState<"symbol" | "global" | "geo">("symbol");

  const geo = mode === "geo";
  const interval = geo ? 60_000 : 30_000;

  const { data = [], isLoading } = useQuery({
    queryKey: ["news", mode, symbol],
    queryFn: () =>
      mode === "geo"
        ? apiGet<NewsItem[]>("/api/news/geopolitics")
        : mode === "global"
          ? apiGet<NewsItem[]>("/api/news")
          : apiGet<NewsItem[]>(`/api/news?symbol=${symbol}`),
    refetchInterval: interval,
  });

  return (
    <div>
      <div className="flex gap-1 p-1">
        <button className={`term-btn ${mode === "symbol" ? "active" : ""}`} onClick={() => setMode("symbol")}>
          {symbol === "XAUUSD" ? "GOLD" : symbol}
        </button>
        <button className={`term-btn ${mode === "global" ? "active" : ""}`} onClick={() => setMode("global")}>
          MARKET
        </button>
        <button className={`term-btn ${mode === "geo" ? "active" : ""}`} onClick={() => setMode("geo")} title="Geopolitics / safe-haven triggers">
          GEO
        </button>
      </div>
      {isLoading && <div className="p-2 dim">Loading news…</div>}
      {data.map((n, i) => (
        <a
          key={i}
          href={n.link}
          target="_blank"
          rel="noreferrer"
          className="block px-2 py-1 border-b border-[#161616] hover:bg-[#161616]"
        >
          <div className="truncate">
            <span
              className={`${SENT[n.sentiment ?? "neutral"]?.cls} mr-1`}
              title={`${SENT[n.sentiment ?? "neutral"]?.label} for gold`}
            >
              {SENT[n.sentiment ?? "neutral"]?.mark}
            </span>
            {n.title}
          </div>
          <div className="dim text-[10px]">
            {n.publisher}
            {n.impact ? " · " + n.impact : ""}
            {n.publishedAt ? " · " + new Date(n.publishedAt).toLocaleString() : ""}
          </div>
        </a>
      ))}
    </div>
  );
}