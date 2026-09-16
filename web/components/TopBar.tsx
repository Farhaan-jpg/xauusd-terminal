"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, fmt, pctClass, type ApiSettings, type Quote } from "../lib/api";
import { useTerminal } from "../store/terminal";
import { clearTray, ensureNotifyPermission, removeTrayItem, useTray } from "../lib/notify";
import Flash from "./Flash";
import SettingsPanel from "./SettingsPanel";

type Status = {
  ok: boolean;
  uptimeSec?: number;
  staleEntries?: number;
  providers: Array<{ name: string; ok: number; failed: number; lastLatencyMs: number | null }>;
  ai: boolean;
};

function Clock({ tz, label }: { tz: string; label: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  return (
<span className="dim tabular-nums">
        {label}{" "}
      <span className="text-[var(--text)] tabular-nums">
        {now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false })}
      </span>
    </span>
  );
}

/** Gold spot trades from Sunday 22:00 UTC through Friday 21:00 UTC
 *  (the standard OANDA / TradingView XAUUSD session). */
function goldMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0) return mins >= 22 * 60; // Sunday open
  if (day === 6) return false; // Saturday halt
  if (day === 5) return mins < 21 * 60; // Friday close
  return true;
}

export default function TopBar() {
  const setSettings = useTerminal((s) => s.setSettings);
  const settings = useTerminal((s) => s.settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const tray = useTray();

  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
    refetchInterval: 30_000,
  });

  // Runtime settings (refresh intervals, alerts, provider keys) live on the
  // server; this keeps the store in sync so every component reacts instantly.
  useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const s = await apiGet<ApiSettings>("/api/settings");
      setSettings(s);
      return s;
    },
    refetchInterval: 60_000,
  });

  const quoteMs = Math.max(1000, settings?.refreshMs?.quotes ?? 2_000);

  const { data: spot } = useQuery({
    queryKey: ["quote", "topbar", "XAUUSD"],
    queryFn: async () => (await apiGet<Quote[]>("/api/quotes?symbols=XAUUSD"))[0],
    refetchInterval: quoteMs,
  });

  const open = goldMarketOpen();
  const healthy = status?.providers.filter((p) => p.ok > 0) ?? [];

  return (
    <header className="flex items-center gap-3 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0 whitespace-nowrap">
      <span className="amber font-bold tracking-widest shrink-0">XAUUSD TERMINAL</span>
      <span className="dim shrink-0" title="Gold spot / US Dollar (OANDA:TradingView)">
        GOLD SPOT · USD
      </span>
      <span className={`shrink-0 ${open ? "up" : "down"}`}>● {open ? "GOLD MKT OPEN" : "GOLD MKT CLOSED"}</span>
      <span className="w-px h-3.5 self-center bg-[var(--border)] shrink-0" />
      <span className="flex items-center gap-3 shrink-0">
        <Clock tz="America/New_York" label="NY" />
        <Clock tz="Europe/London" label="LDN" />
        <Clock tz="Asia/Tokyo" label="TYO" />
        <Clock tz="UTC" label="UTC" />
      </span>

      <div className="ml-auto flex items-center gap-3 min-w-0">
        {spot?.price !== undefined && (
          <span className="flex items-center gap-2 shrink-0">
            <span className="dim">XAUUSD</span>
            <Flash value={spot.price} className="text-[var(--text)] tabular-nums">
              {fmt(spot.price)}
            </Flash>
            <Flash value={spot.changePercent} className={pctClass(spot.changePercent)}>
              {spot.changePercent !== null ? `${spot.change !== null && spot.change >= 0 ? "+" : ""}${fmt(spot.changePercent)}%` : "—"}
            </Flash>
          </span>
        )}
        <span className="w-px h-3.5 self-center bg-[var(--border)] shrink-0" />
        <span
          className="dim min-w-0 overflow-hidden text-ellipsis"
          title={healthy.length > 0 ? healthy.map((p) => `${p.name} ${p.lastLatencyMs ?? "—"}ms`).join(" · ") : "connecting…"}
        >
          feeds:{" "}
          {healthy.length > 0
            ? healthy.map((p) => `${p.name} ${p.lastLatencyMs ?? "—"}ms`).join(" · ")
            : "connecting…"}
        </span>
      </div>

      <span className={`shrink-0 ${status?.ai ? "up" : "dim"}`} title="AI analyst: any provider key configured">
        AI {status?.ai ? "●" : "○"}
      </span>

      {/* Alert tray (bell) */}
      <div className="relative shrink-0">
        <button
          className="term-btn !px-2 relative"
          title="Alert history"
          onClick={() => setTrayOpen((v) => !v)}
        >
          🔔
          {tray.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 bg-[var(--amber)] text-black text-[9px] font-bold rounded-full px-1 leading-4">
              {tray.length > 9 ? "9+" : tray.length}
            </span>
          )}
        </button>
        {trayOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setTrayOpen(false)} />
            <div className="absolute right-0 top-8 z-50 w-80 max-h-96 overflow-auto bg-[var(--panel-2)] border border-[var(--border)] shadow-xl text-[11px] flex flex-col">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)]">
                <span className="dim uppercase tracking-wide">Alert history</span>
                <div className="flex items-center gap-2">
                  <button className="dim hover:text-[var(--amber)]" onClick={() => void ensureNotifyPermission()} title="Enable desktop notifications">
                    ⍰
                  </button>
                  {tray.length > 0 && (
                    <button className="dim hover:text-[var(--down)]" onClick={clearTray}>CLEAR</button>
                  )}
                </div>
              </div>
              {tray.length === 0 ? (
                <div className="p-3 dim">No alerts yet.</div>
              ) : (
                tray.slice(0, 25).map((t) => (
                  <div key={t.id} className="flex items-start gap-2 px-3 py-1.5 border-b border-[var(--border)] last:border-0">
                    <span className={`shrink-0 ${t.tone} font-bold`}>{t.tone === "up" ? "▲" : t.tone === "down" ? "▼" : "◆"}</span>
                    <span className="flex-1 min-w-0 break-words">{t.text}</span>
                    <span
                      className="dim shrink-0 cursor-pointer hover:text-[var(--down)]"
                      title="Dismiss"
                      onClick={() => removeTrayItem(t.id)}
                    >
                      ✕
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <button
        className="term-btn !px-2 shrink-0"
        title="Settings — API keys, alerts, refresh intervals, AI provider order"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}