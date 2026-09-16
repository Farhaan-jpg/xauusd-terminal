"use client";

import { useEffect, useRef, useState } from "react";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

const TIMEFRAMES = [
  { key: "1m", label: "1M" },
  { key: "5m", label: "5M" },
  { key: "15m", label: "15M" },
  { key: "30m", label: "30M" },
  { key: "1h", label: "1H" },
  { key: "4h", label: "4H" },
  { key: "1D", label: "1D" },
  { key: "1W", label: "1W" },
  { key: "1M", label: "1M" },
] as const;

type RangeKey = (typeof TIMEFRAMES)[number]["key"];

const TV_SYMBOL: Record<string, string> = {
  XAUUSD: "OANDA:XAUUSD",
  "XAUUSD=X": "OANDA:XAUUSD",
  XAGUSD: "OANDA:XAGUSD",
  "XAGUSD=X": "OANDA:XAGUSD",
  "GC=F": "COMEX:GC1!",
  "SI=F": "COMEX:SI1!",
  "DX-Y.NYB": "TVC:DXY",
  EURUSD: "OANDA:EURUSD",
  "EURUSD=X": "OANDA:EURUSD",
  GBPUSD: "OANDA:GBPUSD",
  "GBPUSD=X": "OANDA:GBPUSD",
  USDJPY: "OANDA:USDJPY",
  "USDJPY=X": "OANDA:USDJPY",
  GLD: "AMEX:GLD",
  GDX: "NYSEARCA:GDX",
  TLT: "NYSEARCA:TLT",
  UUP: "NYSEARCA:UUP",
  SPY: "AMEX:SPY",
};

const TV_INTERVAL: Record<RangeKey, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1D": "D",
  "1W": "W",
  "1M": "1M",
};

export default function ChartWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [range, setRange] = useState<RangeKey>("15m");
  const containerRef = useRef<HTMLDivElement>(null);

  const tvSymbol = TV_SYMBOL[symbol];

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !tvSymbol) return;
    el.innerHTML = "";

    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    s.async = true;
    s.type = "text/javascript";
    s.textContent = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: TV_INTERVAL[range],
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(10,10,10,1)",
      gridColor: "rgba(38,38,38,1)",
      hide_side_toolbar: false,
      allow_symbol_change: false,
      details: false,
      hotlist: false,
      show_popup_button: true,
      popup_width: "1000",
      popup_height: "650",
      toolbar_bg: "#111111",
    });
    el.appendChild(s);
    return () => {
      el.innerHTML = "";
    };
  }, [tvSymbol, range]);

  if (!tvSymbol) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-1 p-1 flex-wrap shrink-0">
          {TIMEFRAMES.map((tf) => (
            <button key={tf.key} className={`term-btn ${range === tf.key ? "active" : ""}`} onClick={() => setRange(tf.key)}>
              {tf.label}
            </button>
          ))}
        </div>
        <div className="flex-1 flex items-center justify-center dim">
          TradingView chart not available for {symbol}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 p-1 flex-wrap shrink-0 items-center">
        {TIMEFRAMES.map((tf) => (
          <button key={tf.key} className={`term-btn ${range === tf.key ? "active" : ""}`} onClick={() => setRange(tf.key)}>
            {tf.label}
          </button>
        ))}
        <span className="dim text-[10px] ml-1">{tvSymbol}</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}