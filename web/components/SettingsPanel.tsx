"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost, type AiProviderKey, type ApiSettings } from "../lib/api";

type Settings = ApiSettings;

type Props = { open: boolean; onClose: () => void };

const AI_LABELS: Record<AiProviderKey, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
  nvidia: "NVIDIA",
  gemini: "Google Gemini",
  anthropic: "Anthropic",
};
const AI_MODELS: Record<AiProviderKey, string> = {
  openrouter: "openrouter/free auto-route",
  groq: "openai/gpt-oss-120b",
  nvidia: "nvidia/nemotron-3-super-120b-a12b",
  gemini: "gemini-3-flash-preview",
  anthropic: "claude-3-5-sonnet-20241022",
};

export default function SettingsPanel({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyTarget, setKeyTarget] = useState<AiProviderKey>("openrouter");
  const [testResult, setTestResult] = useState<{ provider: string; ok: boolean; msg: string } | null>(null);
  const [levelSym, setLevelSym] = useState("XAUUSD");
  const [levelPrice, setLevelPrice] = useState("");
  const [levelDir, setLevelDir] = useState<"above" | "below">("above");

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<Settings>("/api/settings"),
    enabled: open,
  });

  // Live model info straight from the server (the current free-tier chain).
  const { data: providerMeta } = useQuery({
    queryKey: ["settings-providers"],
    queryFn: () =>
      apiGet<{ providers: Array<{ provider: AiProviderKey; label: string; model: string }> }>("/api/settings/providers"),
    enabled: open,
    refetchInterval: 60_000,
  });
  const modelOf = (p: AiProviderKey) =>
    providerMeta?.providers.find((x) => x.provider === p)?.model ?? AI_MODELS[p];

  // Provider health from /api/status — availability % per feed + stale cache.
  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: () =>
      apiGet<{
        ok: boolean;
        uptimeSec?: number;
        staleEntries?: number;
        providers: Array<{ name: string; ok: number; failed: number; lastLatencyMs: number | null }>;
      }>("/api/status"),
    enabled: open,
    refetchInterval: 15_000,
  });

  useEffect(() => { if (settings) setDraft(structuredClone(settings)); }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      await apiPost("/api/settings", {
        alerts: draft.alerts,
        refreshMs: draft.refreshMs,
        providerOrder: draft.providerOrder,
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); onClose(); },
  });

  const addKeyMutation = useMutation({
    mutationFn: async () => {
      await apiPost("/api/settings", { apiKeys: { [keyTarget]: keyInput.trim() } });
    },
    onSuccess: () => { setKeyInput(""); qc.invalidateQueries({ queryKey: ["settings"] }); },
  });

  const removeKey = async (p: AiProviderKey) => {
    await apiPost("/api/settings", { apiKeys: { [p]: "" } });
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const testKey = async (p: AiProviderKey) => {
    setTestResult(null);
    try {
      const r = await apiPost<{ ok: boolean; provider: string; model: string } & Record<string, string>>("/api/settings/test", { provider: p });
      setTestResult({ provider: p, ok: true, msg: `${r.model}` });
    } catch (err) {
      setTestResult({ provider: p, ok: false, msg: (err as Error).message });
    }
    setTimeout(() => setTestResult(null), 4000);
  };

  if (!open) return null;

  const d = draft;
  if (!d) return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"><div className="panel">Loading…</div></div>;

  const moveProvider = (p: AiProviderKey, dir: -1 | 1) => {
    const idx = d.providerOrder.indexOf(p);
    if (idx < 0) return;
    const next = [...d.providerOrder];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setDraft({ ...d, providerOrder: next });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-[var(--panel)] border border-[var(--border)] max-w-xl w-full max-h-[80vh] overflow-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="panel-title justify-between">
          <span>SETTINGS</span>
          <button onClick={onClose} className="dim hover:text-[var(--down)]">✕</button>
        </div>

        <div className="p-4 space-y-5 text-[11px] flex-1 overflow-auto">
          {/* --- AI Providers --- */}
          <section>
            <h3 className="dim uppercase tracking-wide mb-1">AI Provider Fallback Order</h3>
            <p className="dim mb-2">Responses fall through to the next configured provider if the first fails.</p>
            <div className="space-y-1">
              {d.providerOrder.map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <button className="dim hover:text-[var(--amber)]" onClick={() => moveProvider(p, -1)} disabled={d.providerOrder.indexOf(p) === 0}>▲</button>
                  <button className="dim hover:text-[var(--amber)]" onClick={() => moveProvider(p, 1)} disabled={d.providerOrder.indexOf(p) === d.providerOrder.length - 1}>▼</button>
                  <span className="w-32">{AI_LABELS[p]}</span>
                  <span className="dim flex-1 truncate">{modelOf(p)}</span>
                  <span className={d.providers[p] ? "up" : "dim"}>{d.providers[p] ? "●" : "○"}</span>
                  <button className="term-btn !py-0 !px-2" onClick={() => testKey(p)}>
                    {testResult?.provider === p ? (testResult.ok ? "OK" : "ERR") : "TEST"}
                  </button>
                  <button
                    className="term-btn !py-0 !px-2"
                    onClick={() => (d.providers[p] ? removeKey(p) : setKeyTarget(p))}
                  >
                    {d.providers[p] ? "REMOVE" : "SET KEY…"}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <select value={keyTarget} onChange={(e) => setKeyTarget(e.target.value as AiProviderKey)} className="term-btn !py-0.5">
                {d.providerOrder.map((p) => <option key={p} value={p}>{AI_LABELS[p]}</option>)}
              </select>
              <input
                type="password"
                value={keyTarget === keyTarget ? keyInput : ""}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && keyInput.trim() && addKeyMutation.mutate()}
                placeholder="paste API key…"
                className="flex-1"
              />
              <button className="term-btn" disabled={!keyInput.trim()} onClick={() => addKeyMutation.mutate()}>SAVE KEY</button>
            </div>
            {testResult && (
              <div className={`mt-1 ${testResult.ok ? "up" : "down"}`}>
                {AI_LABELS[testResult.provider as AiProviderKey]}: {testResult.msg}
              </div>
            )}
          </section>

          <hr className="border-[var(--border)]" />

          {/* --- Alerts --- */}
          <section>
            <h3 className="dim uppercase tracking-wide mb-2">Alerts</h3>
            <label className="flex items-center gap-2 mb-1">
              <input type="checkbox" checked={d.alerts.enabled} onChange={() => setDraft({ ...d, alerts: { ...d.alerts, enabled: !d.alerts.enabled } })} />
              Enable alerts
            </label>
            {d.alerts.enabled && (
              <>
                <label className="flex items-center gap-2 mb-1">
                  <input type="checkbox" checked={d.alerts.sound} onChange={() => setDraft({ ...d, alerts: { ...d.alerts, sound: !d.alerts.sound } })} />
                  Play sound on alert
                </label>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36">Alert sound</span>
                  <select
                    value={d.alerts.display}
                    onChange={(e) => setDraft({ ...d, alerts: { ...d.alerts, display: e.target.value as "beep" | "tone" } })}
                    className="term-btn !py-0.5 bg-[var(--panel)] cursor-pointer"
                  >
                    <option value="beep">beep</option>
                    <option value="tone">tone</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 mb-1">
                  <input type="checkbox" checked={d.alerts.highImpact} onChange={() => setDraft({ ...d, alerts: { ...d.alerts, highImpact: !d.alerts.highImpact } })} />
                  High-impact events & geopolitics
                </label>
                <label className="flex items-center gap-2 mb-1">
                  <input type="checkbox" checked={d.alerts.notifications} onChange={() => setDraft({ ...d, alerts: { ...d.alerts, notifications: !d.alerts.notifications } })} />
                  Desktop notifications (OS)
                </label>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36">High-impact countdown</span>
                  <input
                    type="number" min="1" max="120"
                    value={d.alerts.countdownMin}
                    onChange={(e) => setDraft({ ...d, alerts: { ...d.alerts, countdownMin: Math.max(1, Math.min(120, Number(e.target.value) || 15)) } })}
                    className="w-20"
                  />
                  <span className="dim">min before release</span>
                </div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36 shrink-0">News keywords</span>
                  <input
                    value={(d.alerts.newsKeywords ?? []).join(", ")}
                    onChange={(e) =>
                      setDraft({
                        ...d,
                        alerts: { ...d.alerts, newsKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20) },
                      })
                    }
                    placeholder="cpi, fed, tariffs, missile…"
                    className="flex-1"
                  />
                </div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36">Price move threshold %</span>
                  <input
                    type="number" step="0.05" min="0.05" max="10"
                    value={d.alerts.thresholdPct}
                    onChange={(e) => setDraft({ ...d, alerts: { ...d.alerts, thresholdPct: Math.max(0.05, Math.min(10, Number(e.target.value) || 0.5)) } })}
                    className="w-20"
                  />
                </div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36">Volume</span>
                  <input
                    type="range" min="0" max="1" step="0.1"
                    value={d.alerts.volume}
                    onChange={(e) => setDraft({ ...d, alerts: { ...d.alerts, volume: Number(e.target.value) } })}
                    className="w-48"
                  />
                  <span className="dim w-8">{d.alerts.volume.toFixed(1)}</span>
                </div>
                <div className="text-[10px] dim uppercase tracking-wide mt-3 mb-1">Price level alerts</div>
                {(d.alerts.levels ?? []).map((l, i) => (
                  <div key={`${l.symbol}-${l.level}-${l.dir}-${i}`} className="flex items-center gap-2 mb-1">
                    <span className="w-20 truncate">{l.symbol}</span>
                    <span className={`w-28 ${l.dir === "above" ? "up" : "down"}`}>
                      {l.dir === "above" ? "≥" : "≤"} {l.level.toFixed(2)}
                    </span>
                    <button
                      className="term-btn !py-0 !px-2 dim"
                      onClick={() =>
                        setDraft({ ...d, alerts: { ...d.alerts, levels: (d.alerts.levels ?? []).filter((_, k) => k !== i) } })
                      }
                    >
                      REMOVE
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2 mt-1">
                  <input
                    value={levelSym}
                    onChange={(e) => setLevelSym(e.target.value.toUpperCase())}
                    className="w-20"
                    placeholder="SYMBOL"
                  />
                  <select
                    value={levelDir}
                    onChange={(e) => setLevelDir(e.target.value as "above" | "below")}
                    className="term-btn !py-0.5 bg-[var(--panel)] cursor-pointer"
                  >
                    <option value="above">above ≥</option>
                    <option value="below">below ≤</option>
                  </select>
                  <input
                    type="number" step="0.01"
                    value={levelPrice}
                    onChange={(e) => setLevelPrice(e.target.value)}
                    className="w-24"
                    placeholder="PRICE"
                  />
                  <button
                    className="term-btn !py-0 !px-2"
                    disabled={!levelPrice || !levelSym.trim()}
                    onClick={() => {
                      const level = Number(levelPrice);
                      if (!Number.isFinite(level)) return;
                      const symbol = levelSym.trim().toUpperCase() || "XAUUSD";
                      setDraft({
                        ...d,
                        alerts: { ...d.alerts, levels: [...(d.alerts.levels ?? []), { symbol, level, dir: levelDir }] },
                      });
                      setLevelPrice("");
                    }}
                  >
                    ADD
                  </button>
                </div>
                <div className="text-[10px] dim uppercase tracking-wide mt-3 mb-1">
                  Webhook relay — alerts fire even while the app is closed
                </div>
                <label className="flex items-center gap-2 mb-1">
                  <input
                    type="checkbox"
                    checked={d.alerts.webhook.enabled}
                    onChange={() => setDraft({ ...d, alerts: { ...d.alerts, webhook: { enabled: !d.alerts.webhook.enabled, url: d.alerts.webhook.url } } })}
                  />
                  Send alerts to webhook
                </label>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-36 shrink-0">Webhook URL</span>
                  <input
                    value={d.alerts.webhook.url}
                    onChange={(e) => setDraft({ ...d, alerts: { ...d.alerts, webhook: { ...d.alerts.webhook, url: e.target.value } } })}
                    placeholder="https://hooks.slack.com/…"
                    className="flex-1"
                  />
                </div>
              </>
            )}
          </section>

          <hr className="border-[var(--border)]" />

          {/* --- Refresh --- */}
          <section>
            <h3 className="dim uppercase tracking-wide mb-2">Refresh Intervals (ms)</h3>
            {(["quotes", "charts", "markets", "news"] as const).map((k) => (
              <div key={k} className="flex items-center gap-2 mb-1">
                <span className="w-36 capitalize">{k}</span>
                <input
                  type="number"
                  min={k === "quotes" ? 500 : k === "news" ? 5000 : 1000}
                  max={k === "quotes" ? 60_000 : k === "news" ? 600_000 : 120_000}
                  value={d.refreshMs[k]}
                  onChange={(e) => setDraft({ ...d, refreshMs: { ...d.refreshMs, [k]: Math.max(1000, Number(e.target.value) || 2000) } })}
                  className="w-24"
                />
              </div>
            ))}
          </section>

          <hr className="border-[var(--border)]" />

          {/* --- System Health --- */}
          <section>
            <h3 className="dim uppercase tracking-wide mb-2">System Health</h3>
            {status ? (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="dim">Uptime</span>
                  <span className="tabular-nums">
                    {status.uptimeSec !== undefined ? `${Math.floor(status.uptimeSec / 60)}m ${status.uptimeSec % 60}s` : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="dim">Last-known cache entries</span>
                  <span className="tabular-nums">{status.staleEntries ?? "—"}</span>
                </div>
                <table className="w-full border-collapse mt-1">
                  <thead>
                    <tr className="dim text-[10px] uppercase tracking-wide">
                      <th className="text-left pb-1">Feed</th>
                      <th className="text-right pb-1">OK</th>
                      <th className="text-right pb-1">Failed</th>
                      <th className="text-right pb-1">Avail. %</th>
                      <th className="text-right pb-1">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.providers
                      .filter((p) => p.ok > 0 || p.failed > 0)
                      .map((p) => {
                        const total = p.ok + p.failed;
                        const avail = total > 0 ? (p.ok / total) * 100 : 0;
                        return (
                          <tr key={p.name} className="border-t border-[#161616]">
                            <td className="py-0.5">{p.name}</td>
                            <td className="py-0.5 text-right tabular-nums up">{p.ok}</td>
                            <td className={`py-0.5 text-right tabular-nums ${p.failed > 0 ? "down" : "dim"}`}>{p.failed}</td>
                            <td className={`py-0.5 text-right tabular-nums ${avail >= 80 ? "up" : avail >= 40 ? "" : "down"}`}>
                              {avail.toFixed(0)}%
                            </td>
                            <td className="py-0.5 text-right tabular-nums dim">
                              {p.lastLatencyMs !== null ? `${p.lastLatencyMs}ms` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="dim">Loading health…</div>
            )}
          </section>
        </div>

        {/* footer */}
        <div className="flex justify-end gap-2 p-3 border-t border-[var(--border)] shrink-0">
          <button className="term-btn" onClick={onClose}>Cancel</button>
          <button className="term-btn active" onClick={() => saveMutation.mutate()}>Save</button>
        </div>
      </div>
    </div>
  );
}