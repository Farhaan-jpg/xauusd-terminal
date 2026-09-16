"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AiProviderKey, ApiSettings } from "../lib/api";

/** Canonical symbol for gold spot / US dollar — the whole terminal revolves
 *  around this. Chart widgets may be pointed at a correlated instrument
 *  (DXY, silver, gold futures, GDX…) via the Correlations widget. */
export const GOLD_SYMBOL = "XAUUSD";

export type WidgetType =
  | "chart"
  | "quote"
  | "levels"
  | "correlations"
  | "news"
  | "calendar"
  | "ai"
  | "bias"
  | "session"
  | "seasonality"
  | "sessionstats"
  | "tape"
  | "stats"
  | "curve"
  | "options"
  | "cot"
  | "rates"
  | "flows"
  | "matrix";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string; // only meaningful for chart widgets
};

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };

type TerminalState = {
  widgets: WidgetInstance[];
  layout: LayoutItem[];

  // runtime (never persisted): workspace window controls + server settings
  maximizedId: string | null;
  collapsed: Record<string, boolean>;
  settings: ApiSettings | null;

  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  setLayout: (layout: LayoutItem[]) => void;
  resetWorkspace: () => void;
  loadWorkspace: (widgets: WidgetInstance[], layout: LayoutItem[]) => void;
  setMaximized: (id: string | null) => void;
  toggleCollapsed: (id: string) => void;
  setSettings: (s: ApiSettings | null) => void;
};

const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-chart", type: "chart" },
  { id: "w-quote", type: "quote" },
  { id: "w-bias", type: "bias" },
  { id: "w-levels", type: "levels" },
  { id: "w-corr", type: "correlations" },
  { id: "w-news", type: "news" },
  { id: "w-calendar", type: "calendar" },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-chart", x: 0, y: 0, w: 8, h: 13, minW: 4, minH: 4 },
  { i: "w-quote", x: 8, y: 0, w: 4, h: 5, minW: 3, minH: 3 },
  { i: "w-bias", x: 8, y: 5, w: 4, h: 4, minW: 3, minH: 3 },
  { i: "w-levels", x: 8, y: 9, w: 4, h: 5, minW: 3, minH: 3 },
  { i: "w-corr", x: 8, y: 14, w: 4, h: 8, minW: 3, minH: 4 },
  { i: "w-news", x: 0, y: 13, w: 8, h: 6, minW: 3, minH: 4 },
  { i: "w-calendar", x: 8, y: 22, w: 4, h: 6, minW: 4, minH: 4 },
  { i: "w-ai", x: 4, y: 22, w: 4, h: 6, minW: 3, minH: 4 },
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  chart: { w: 7, h: 12 },
  quote: { w: 4, h: 5 },
  levels: { w: 4, h: 5 },
  correlations: { w: 4, h: 8 },
  news: { w: 5, h: 7 },
  calendar: { w: 6, h: 7 },
  ai: { w: 4, h: 9 },
  bias: { w: 4, h: 4 },
  session: { w: 4, h: 6 },
  seasonality: { w: 6, h: 7 },
  sessionstats: { w: 5, h: 7 },
  tape: { w: 4, h: 8 },
  stats: { w: 4, h: 7 },
  curve: { w: 5, h: 7 },
  options: { w: 4, h: 6 },
  cot: { w: 4, h: 5 },
  rates: { w: 4, h: 6 },
  flows: { w: 4, h: 6 },
  matrix: { w: 7, h: 9 },
};

const MIN_BY_TYPE: Record<WidgetType, { minW: number; minH: number }> = {
  chart: { minW: 4, minH: 4 },
  quote: { minW: 3, minH: 3 },
  levels: { minW: 3, minH: 3 },
  correlations: { minW: 3, minH: 4 },
  news: { minW: 3, minH: 4 },
  calendar: { minW: 4, minH: 4 },
  ai: { minW: 3, minH: 4 },
  bias: { minW: 3, minH: 3 },
  session: { minW: 3, minH: 4 },
  seasonality: { minW: 4, minH: 4 },
  sessionstats: { minW: 4, minH: 4 },
  tape: { minW: 3, minH: 4 },
  stats: { minW: 3, minH: 4 },
  curve: { minW: 4, minH: 4 },
  options: { minW: 3, minH: 4 },
  cot: { minW: 3, minH: 3 },
  rates: { minW: 3, minH: 4 },
  flows: { minW: 3, minH: 4 },
  matrix: { minW: 4, minH: 4 },
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      maximizedId: null,
      collapsed: {},
      settings: null,
      addWidget: (type, symbol) =>
        set((st) => {
          const id = `w-${type}-${Date.now()}`;
          const size = SIZE_BY_TYPE[type];
          const min = MIN_BY_TYPE[type];
          const maxY = st.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...st.widgets, { id, type, symbol }],
            layout: [...st.layout, { i: id, x: 0, y: maxY, ...size, ...min }],
          };
        }),
      removeWidget: (id) =>
        set((st) => ({
          widgets: st.widgets.filter((w) => w.id !== id),
          layout: st.layout.filter((l) => l.i !== id),
          collapsed: Object.fromEntries(Object.entries(st.collapsed).filter(([k]) => k !== id)),
          maximizedId: st.maximizedId === id ? null : st.maximizedId,
        })),
      setWidgetSymbol: (id, symbol) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, symbol: symbol.toUpperCase() } : w)),
        })),
      setLayout: (layout) => set({ layout }),
      resetWorkspace: () =>
        set({ widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT, maximizedId: null, collapsed: {} }),
      loadWorkspace: (widgets, layout) =>
        set({ widgets, layout, maximizedId: null, collapsed: {} }),
      setMaximized: (id) => set({ maximizedId: id }),
      toggleCollapsed: (id) =>
        set((st) => ({
          collapsed: { ...st.collapsed, [id]: !st.collapsed[id] },
          maximizedId: st.maximizedId === id ? null : st.maximizedId,
        })),
      setSettings: (s) => set({ settings: s }),
    }),
    {
      name: "xauusd-terminal-workspace-v1",
      // persist workspace layout only; window/settings state is runtime
      partialize: (s) => ({ widgets: s.widgets, layout: s.layout }),
    }
  )
);

/** Symbol a widget should display: its own (correlated charts) or gold. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  return widget.symbol ?? GOLD_SYMBOL;
}