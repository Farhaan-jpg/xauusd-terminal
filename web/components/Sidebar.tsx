"use client";

import { useEffect, useState } from "react";
import { useTerminal, type WidgetType } from "../store/terminal";

const ITEMS: Array<{ type: WidgetType; label: string; key: string }> = [
  { type: "chart", label: "CHART", key: "⌥1" },
  { type: "quote", label: "SPOT QUOTE", key: "⌥2" },
  { type: "bias", label: "MARKET BIAS", key: "⌥8" },
  { type: "levels", label: "PIVOT LEVELS", key: "⌥3" },
  { type: "correlations", label: "CORRELATIONS", key: "⌥4" },
  { type: "news", label: "GOLD NEWS", key: "⌥5" },
  { type: "calendar", label: "CALENDAR", key: "⌥6" },
  { type: "ai", label: "AI ANALYST", key: "⌥7" },
  { type: "session", label: "SESSIONS", key: "⌥9" },
  { type: "seasonality", label: "SEASONALITY", key: "—" },
  { type: "sessionstats", label: "SESSION STATS", key: "—" },
  { type: "tape", label: "TICK TAPE", key: "—" },
  { type: "stats", label: "STATS DESK", key: "—" },
  { type: "curve", label: "FUTURES CURVE", key: "—" },
  { type: "options", label: "GC OPTIONS", key: "—" },
  { type: "cot", label: "COT POSITIONING", key: "—" },
  { type: "rates", label: "RATE ODDS", key: "—" },
  { type: "flows", label: "ETF FLOWS", key: "—" },
  { type: "matrix", label: "CORRELATION MATRIX", key: "—" },
];

const PROFILES_KEY = "xauusd-terminal-profiles-v1";

type Profile = { name: string; ws: { widgets: unknown[]; layout: unknown[] } };

function readProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, { widgets: unknown[]; layout: unknown[] }>;
    return Object.entries(parsed).map(([name, ws]) => ({ name, ws }));
  } catch {
    return [];
  }
}

function writeProfile(name: string, ws: { widgets: unknown[]; layout: unknown[] }): void {
  const all = readProfiles();
  const map = Object.fromEntries(all.map((p) => [p.name, p.ws]));
  map[name] = ws;
  localStorage.setItem(PROFILES_KEY, JSON.stringify(map));
}

function deleteProfile(name: string): void {
  const all = readProfiles();
  const map = Object.fromEntries(all.map((p) => [p.name, p.ws]));
  delete map[name];
  localStorage.setItem(PROFILES_KEY, JSON.stringify(map));
}

export default function Sidebar() {
  const addWidget = useTerminal((s) => s.addWidget);
  const resetWorkspace = useTerminal((s) => s.resetWorkspace);
  const loadWorkspace = useTerminal((s) => s.loadWorkspace);
  const widgets = useTerminal((s) => s.widgets);
  const layout = useTerminal((s) => s.layout);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setProfiles(readProfiles());
    // Share link restore: #ws=<base64(JSON {widgets, layout})>
    const hash = window.location.hash;
    if (hash.startsWith("#ws=")) {
      try {
        const json = JSON.parse(decodeURIComponent(atob(hash.slice(4))));
        if (Array.isArray(json?.widgets) && Array.isArray(json?.layout) && json.widgets.every((w: any) => w?.id && w?.type)) {
          loadWorkspace(json.widgets, json.layout);
        }
      } catch {
        // ignore malformed links
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveProfile = () => {
    const name = window.prompt("Profile name:")?.trim();
    if (!name) return;
    writeProfile(name, { widgets, layout });
    setProfiles(readProfiles());
  };

  const shareLink = async () => {
    const payload = btoa(encodeURIComponent(JSON.stringify({ widgets, layout })));
    const url = `${window.location.origin}${window.location.pathname}#ws=${payload}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this share link:", url);
    }
  };

  return (
    <nav className="term-sidebar w-32 bg-[var(--panel)] border-r border-[var(--border)] flex flex-col shrink-0">
      <div className="term-sidebar-head dim px-2 py-1 text-[10px] uppercase tracking-wider border-b border-[var(--border)]">
        Add widget
      </div>
      <div className="term-sidebar-scroll overflow-y-auto flex-1">
        {ITEMS.map((item) => (
          <button
            key={item.type}
            onClick={() => addWidget(item.type)}
            className="block w-full text-left px-2 py-1.5 text-[11px] hover:bg-[#1a1a1a] hover:text-[var(--amber)] flex justify-between"
          >
            <span>{item.label}</span>
            <span className="dim text-[9px]">{item.key}</span>
          </button>
        ))}
      </div>
      <div className="term-sidebar-foot border-t border-[var(--border)] p-1.5 flex flex-col gap-1">
        {profiles.length > 0 && (
          <select
            className="bg-[#141414] border border-[var(--border)] text-[10px] px-1 py-0.5 w-full text-[var(--text)]"
            defaultValue=""
            onChange={(e) => {
              const p = profiles.find((x) => x.name === e.target.value);
              if (p) loadWorkspace(p.ws.widgets as any, p.ws.layout as any);
            }}
            title="Load a saved workspace profile"
          >
            <option value="" disabled>
              Load profile…
            </option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-1">
          <button
            onClick={saveProfile}
            className="flex-1 text-left px-1.5 py-1 text-[10px] border border-[var(--border)] dim hover:text-[var(--amber)]"
            title="Save this widget layout as a named profile"
          >
            SAVE WS
          </button>
          <button
            onClick={shareLink}
            className="flex-1 text-left px-1.5 py-1 text-[10px] border border-[var(--border)] dim hover:text-[var(--amber)]"
            title="Copy a shareable link for this exact layout (#ws=)"
          >
            {copied ? "COPIED ✓" : "SHARE"}
          </button>
        </div>
        <button
          onClick={resetWorkspace}
          className="w-full text-left px-1.5 py-1 text-[10px] dim hover:text-[var(--down)]"
        >
          RESET LAYOUT
        </button>
      </div>
    </nav>
  );
}