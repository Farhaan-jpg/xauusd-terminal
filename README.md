<div align="center">

# XAUUSD Terminal

**A dedicated trading terminal for Gold Spot / US Dollar (XAUUSD) — OANDA · TradingView style.**

Dark, dense, keyboard-driven, and built entirely on free, public market data.
Zero paid API keys, zero subscriptions.

[![Stack](https://img.shields.io/badge/stack-Next.js%20%2B%20Express%20%2B%20TypeScript-orange)](#tech-stack)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![No API Key Required](https://img.shields.io/badge/data-no%20API%20key%20required-brightgreen)](#data-sources)

</div>

## Why XAUUSD Terminal?

Most retail gold traders keep five browser tabs open: a TradingView XAUUSD chart, the DXY, the 10-year real yield, gold news and an economic calendar. This terminal puts all of that on one screen — a professional, keyboard-driven workspace focused *only* on gold, with every data source having a fallback chain so a single provider hiccup never takes the app down.

It is a focused, gold-only build derived from the OpenTerminal market terminal. All equity, crypto, options and screener machinery has been stripped out and replaced with gold-specific analysis panels.

<br/>

## Features

- **TradingView XAUUSD chart** — a fully featured embedded **TradingView advanced chart on the live OANDA:XAUUSD feed** with trading timeframes **1m / 5m / 15m / 30m / 1h / 4h / 1D / 1W / 1M** and full TA tooling; symbol/interval mapping covers every correlated instrument (COMEX:GC1!, TVC:DXY, OANDA:XAGUSD/EURUSD/GBPUSD/USDJPY, AMEX:GLD/SPY, NYSEARCA:GDX/TLT/UUP)
- **Indicators** — TradingView's built-in suite, plus on-terminal SMA20/50/200, EMA20/50, VWAP, Bollinger Bands, RSI, MACD and ATR (via the Market Bias widget and chart legend)
- **Spot quote panel** — last / change / OHLC / bid-ask / 52-week range / price per troy ounce and per gram
- **Pivot levels widget** — classic and Fibonacci daily pivots (S1–S3 / R1–R3), today's range, last completed week's high/low/close and weekly pivots, computed live from spot data, with current level vs price color coding
- **Gold correlations widget** — the drivers that actually move gold: DXY, gold and silver futures, GLD, GDX, EUR/USD, S&P 500, TLT — plus US 2Y/10Y/30Y yields, the **10Y real (TIPS) yield**, breakeven inflation, the fed funds rate and VIX. Rows open as charts; a "Gold drivers" panel reads the current tape
- **Market bias widget** — a real-time **BULL / BEAR / NEUTRAL** call that scores 15m trend, SMA200, VWAP, RSI, MACD, momentum, **DXY (inverse)**, real yields, VIX, silver, gold miners and the futures basis into a weighted gauge with per-factor votes
- **Gold news feed** — headline aggregation for gold/the dollar, per-symbol, market-wide, or a **geopolitics tab** (Al Jazeera + BBC + keyword-filtered Google News) for war/sanction/tariff/bank-gold-buying headlines that move safe havens
- **Economic calendar** — the releases that move gold (Fed, ECB, CPI, NFP…) with consensus, previous and — for the big US/EU prints — the actual outcome (back-filled from the Fed's own data)
- **Alerts & ticker** — a scrolling market ticker plus sound/banner alerts when gold moves past your threshold between polls, when a high-impact economic event hits, or when a **geopolitical headline with High impact breaks** (wars, strikes, sanctions waves, coups); the geopolitics feed is impact-classified (High/Medium/Low)
- **AI analyst** *(optional)* — ask questions about the gold market, context-aware of the current spot quote; auto-falls back across **OpenRouter · Gemini · Groq · NVIDIA · Anthropic** free models, with provider order configurable
- **Settings panel** — add AI API keys (stored server-side, masked), tweak refresh intervals, alert thresholds and the AI provider order without touching code
- **Per-widget resize / maximize / minimize** — full size control: drag the corner handle to resize any widget to your preference (each widget has sensible minimum sizes), `□` to maximize into the full workspace, `–` to collapse a panel to its title bar; your layout persists across reloads
- **Near real-time updates** — quotes refresh as fast as every second (configurable) with a subtle flash on change
- **Keyboard shortcuts** — `Alt+1`–`Alt+8` to add any widget, `RESET LAYOUT` to restore the gold workspace

<br/>

## Data sources

| Data | Primary source | Fallback |
|---|---|---|
| XAUUSD spot quote & candles (intraday + daily) | Sina Finance (`hf_XAU` + `GlobalFuturesService` klines) | Yahoo (`XAUUSD=X`) · Stooq (daily) |
| Silver spot / futures, Gold futures, FX pairs | Sina Finance | Yahoo · Stooq · ECB (FX prev-day closes) |
| US Dollar Index (DXY) | CNBC (`.DXY`) | — |
| Correlated ETFs (GLD, GDX, SPY, TLT, UUP) | Nasdaq | CNBC |
| US 2Y/10Y/30Y yields, 10Y real yield, breakeven, fed funds, VIX | FRED (Federal Reserve) | — |
| Gold news | Google News RSS | Yahoo Finance RSS |
| **Geopolitics news** | **Al Jazeera + BBC + keyword-filtered Google News** | — |
| Economic calendar (schedule, forecast, previous) | Forex Factory public feed | — |
| Economic calendar (actual — Fed / ECB / CPI / NFP only) | FRED (Federal Reserve) | — |
| AI analyst | OpenRouter / Gemini / Groq / NVIDIA / Anthropic (auto-fallback) | — |

> These are public endpoints, not officially licensed data feeds — treat prices as delayed/indicative, not execution-grade. See [`server/src/providers/`](server/src/providers).

<br/>

## Quick start

```bash
npm install
npm run dev
```

- Web UI → **http://localhost:3000**
- API health → **http://localhost:4000/api/status**

That's it — no `.env` file required.

### Optional: AI analyst

```bash
# any one of these is enough; set several for automatic fallback
export OPENROUTER_API_KEY=...     # openrouter/free (auto-routes) → nex-agi/nex-n2.5-pro:free
export GEMINI_API_KEY=...         # gemini-3-flash-preview → gemini-3.8-flash
export GROQ_API_KEY=...           # openai/gpt-oss-120b → qwen/qwen3.8-27b
export NVIDIA_API_KEY=...         # nvidia/nemotron-3-super-120b-a12b → z-ai/glm-5.3-flash
export ANTHROPIC_API_KEY=...      # claude-3-5-sonnet
npm run dev
```

Without a key, everything else still works — the AI widget just shows a friendly "unavailable" message. Keys can also be added at runtime from the **Settings** gear in the top bar (stored on the server in `data/settings.json`, never returned to the browser).

### Security defaults

- The API binds to `127.0.0.1` and only accepts browser requests from `http://localhost:3000` by default.
- The AI and Settings endpoints require a shared secret. If you don't set `API_KEY`, the API generates one on first run and saves it to `data/.api-key`; the bundled web app reads that file automatically.
- Exposing this beyond your own machine (`API_HOST=0.0.0.0`, `API_KEY`, `WEB_ORIGIN`) is possible but not recommended — see the original OpenTerminal docs for the details.

<br/>

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | Next.js 15 · React 19 · TypeScript · Tailwind CSS 4 · Zustand · TanStack Query · `react-grid-layout` |
| Charts | TradingView (embedded) |
| Backend | Node.js · Express · TypeScript |

<br/>

## Project structure

```
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── providers/       # sina, cnbc, nasdaq, fred, econcalendar, news (+ geopolitics), llm (multi-provider AI)
│       ├── routes/          # market (quotes/history/news/gold-macro), ai, settings
│       ├── settings.ts      # runtime settings + AI API keys (data/settings.json)
│       └── cache.ts         # TTL cache with stale-while-revalidate fallback
└── web/                      # Next.js 15 + React 19 + Tailwind 4
    ├── components/           # Terminal, TopBar, Sidebar, Workspace, Ticker, SettingsPanel
    ├── components/widgets/   # Chart, Quote, Levels, Correlations, News, Calendar, AI, Bias
    ├── lib/                  # API client, technical indicators, sounds (WebAudio), alerts hook
    └── store/                # Zustand store (workspace layout, persisted)
```

Run tests with `npm test` (Vitest, no network calls).

<br/>

## Disclaimer

For personal and educational use only. Market data comes from public endpoints and may be delayed, incomplete, or occasionally wrong — **do not use this for real investment decisions**.

This project is not affiliated with, endorsed by, or sponsored by any of the data providers it connects to. It does not host or redistribute data to third parties — it's source code you run yourself, fetching data directly from the provider. Respect the terms of service of the underlying data providers.

## License

[MIT](LICENSE)

</div>