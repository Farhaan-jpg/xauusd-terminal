"use client";

import { useEffect, useRef, useState } from "react";
import GridLayout, { WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { GOLD_SYMBOL, useTerminal, type WidgetInstance } from "../store/terminal";
import QuoteWidget from "./widgets/QuoteWidget";
import ChartWidget from "./widgets/ChartWidget";
import LevelsWidget from "./widgets/LevelsWidget";
import CorrelationsWidget from "./widgets/CorrelationsWidget";
import NewsWidget from "./widgets/NewsWidget";
import CalendarWidget from "./widgets/CalendarWidget";
import AiWidget from "./widgets/AiWidget";
import BiasWidget from "./widgets/BiasWidget";
import SessionWidget from "./widgets/SessionWidget";
import SeasonalityWidget from "./widgets/SeasonalityWidget";
import SessionStatsWidget from "./widgets/SessionStatsWidget";
import TapeWidget from "./widgets/TapeWidget";
import StatsWidget from "./widgets/StatsWidget";
import FuturesCurveWidget from "./widgets/FuturesCurveWidget";
import OptionsWidget from "./widgets/OptionsWidget";
import CotWidget from "./widgets/CotWidget";
import RateProbsWidget from "./widgets/RateProbsWidget";
import FlowWidget from "./widgets/FlowWidget";
import CorrelationMatrixWidget from "./widgets/CorrelationMatrixWidget";
import WidgetErrorBoundary from "./WidgetErrorBoundary";

const Grid = WidthProvider(GridLayout);

function WidgetBody({ widget }: { widget: WidgetInstance }) {
  switch (widget.type) {
    case "chart": return <ChartWidget widget={widget} />;
    case "quote": return <QuoteWidget widget={widget} />;
    case "levels": return <LevelsWidget />;
    case "correlations": return <CorrelationsWidget />;
    case "news": return <NewsWidget widget={widget} />;
    case "calendar": return <CalendarWidget />;
    case "ai": return <AiWidget />;
    case "bias": return <BiasWidget />;
    case "session": return <SessionWidget />;
    case "seasonality": return <SeasonalityWidget />;
    case "sessionstats": return <SessionStatsWidget />;
    case "tape": return <TapeWidget />;
    case "stats": return <StatsWidget />;
    case "curve": return <FuturesCurveWidget />;
    case "options": return <OptionsWidget />;
    case "cot": return <CotWidget />;
    case "rates": return <RateProbsWidget />;
    case "flows": return <FlowWidget />;
    case "matrix": return <CorrelationMatrixWidget />;
  }
}

function SymbolTag({ widget }: { widget: WidgetInstance }) {
  const setWidgetSymbol = useTerminal((s) => s.setWidgetSymbol);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = widget.symbol ?? GOLD_SYMBOL;

  useEffect(() => {
    if (!editing) return;
    setDraft(shown);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = draft.trim();
            if (v) setWidgetSymbol(widget.id, v);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={() => setEditing(false)}
        className="ml-2 w-16 !border-0 !border-b !border-[var(--amber-dim)] bg-transparent text-[var(--text)] px-0 py-0 text-[13px] leading-none"
      />
    );
  }

  return (
    <span
      className="ml-2 text-[var(--text)] cursor-pointer hover:text-[var(--amber)]"
      title="Click to set this chart's symbol (e.g. XAUUSD=X, GC=F, DX-Y.NYB, SI=F)"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => setEditing(true)}
    >
      {shown}
    </span>
  );
}

const TITLES: Record<string, string> = {
  chart: "Chart",
  quote: "Spot Quote",
  levels: "Pivot Levels",
  correlations: "Gold Correlations",
  news: "Gold News",
  calendar: "Economic Calendar",
  ai: "AI Analyst",
  bias: "Market Bias",
  session: "Sessions & Countdown",
  seasonality: "Seasonality",
  sessionstats: "Session Stats",
  tape: "Tick Tape",
  stats: "Stats Desk",
  curve: "Futures Curve",
  options: "GC Options",
  cot: "COT Positioning",
  rates: "Rate Odds",
  flows: "ETF Flows",
  matrix: "Correlation Matrix",
};

const stop = (e: React.MouseEvent) => e.stopPropagation();

function WidgetPanel({
  widget,
  maximized,
  onUnmaximize,
}: {
  widget: WidgetInstance;
  maximized: boolean;
  onUnmaximize: () => void;
}) {
  const collapsed = useTerminal((s) => s.collapsed[widget.id] ?? false);
  const toggleCollapsed = useTerminal((s) => s.toggleCollapsed);
  const setMaximized = useTerminal((s) => s.setMaximized);
  const removeWidget = useTerminal((s) => s.removeWidget);

  return (
    <div className="terminal-panel">
      <div className="panel-title">
        <span>
          {TITLES[widget.type]}
          {widget.type === "chart" && <SymbolTag widget={widget} />}
        </span>
        <span className="flex items-center gap-2">
          <button
            title={collapsed ? "Expand" : "Minimize"}
            onMouseDown={stop}
            onClick={() => toggleCollapsed(widget.id)}
          >
            {collapsed ? "▢" : "–"}
          </button>
          <button
            title={maximized ? "Restore" : "Maximize"}
            onMouseDown={stop}
            onClick={() => (maximized ? onUnmaximize() : setMaximized(widget.id))}
          >
            {maximized ? "❐" : "□"}
          </button>
          <button
            title="Remove widget"
            onMouseDown={stop}
            onClick={() => removeWidget(widget.id)}
            className="dim hover:text-[var(--down)]"
          >
            ✕
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="flex-1 overflow-auto min-h-0">
          <WidgetErrorBoundary name={TITLES[widget.type]} onRemove={() => removeWidget(widget.id)}>
            <WidgetBody widget={widget} />
          </WidgetErrorBoundary>
        </div>
      )}
    </div>
  );
}

export default function Workspace() {
  const widgets = useTerminal((s) => s.widgets);
  const layout = useTerminal((s) => s.layout);
  const setLayout = useTerminal((s) => s.setLayout);
  const maximizedId = useTerminal((s) => s.maximizedId);
  const setMaximized = useTerminal((s) => s.setMaximized);
  const maximized = widgets.find((w) => w.id === maximizedId) ?? null;

  // Phones: render widgets as a vertical stack of full-width cards instead of
  // the 12-column drag grid (react-grid-layout's min column units don't shrink
  // below ~300px; the desktop layout is used unchanged on larger screens).
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (maximized) {
    return (
      <div className="h-full p-1">
        <WidgetPanel widget={maximized} maximized onUnmaximize={() => setMaximized(null)} />
      </div>
    );
  }

  if (compact) {
    return (
      <div className="h-full p-1 flex flex-col gap-1 overflow-y-auto">
        {widgets.map((w) => (
          <div key={w.id} className="shrink-0 h-[52vh] min-h-[240px]">
            <WidgetPanel widget={w} maximized={false} onUnmaximize={() => setMaximized(null)} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Grid
      className="layout"
      layout={layout}
      cols={12}
      rowHeight={30}
      margin={[4, 4]}
      isDraggable
      isResizable
      draggableHandle=".panel-title"
      onLayoutChange={(l) => setLayout(l.map(({ i, x, y, w, h, minW, minH }) => ({ i, x, y, w, h, minW, minH })))}
    >
      {widgets.map((w) => (
        <div key={w.id} className="h-full">
          <WidgetPanel widget={w} maximized={false} onUnmaximize={() => setMaximized(null)} />
        </div>
      ))}
    </Grid>
  );
}