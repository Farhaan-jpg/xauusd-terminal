"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";

type EconEvent = {
  title: string;
  country: string;
  date: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
};

type SessionDef = { label: string; tz: string; openD: number; openM: number; closeD: number; closeM: number };

const W = 86_400_000;
const hhmm = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

// FX / metals sessions in UTC.
const SESSIONS: SessionDef[] = [
  { label: "Sydney", tz: "AEST", openD: 0, openM: 21 * 60, closeD: 1, closeM: 6 * 60 },
  { label: "Tokyo", tz: "JST", openD: 1, openM: 0, closeD: 1, closeM: 6 * 60 },
  { label: "London", tz: "GMT", openD: 1, openM: 7 * 60, closeD: 1, closeM: 16 * 60 },
  { label: "New York", tz: "ET", openD: 1, openM: 13 * 60 + 30, closeD: 1, closeM: 20 * 60 },
];

/** Next occurrence of weekday `dow` at minute `mins` (UTC), at or after t. */
function nextOccurrence(t: number, dow: number, mins: number): number {
  const d = new Date(t);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(mins / 60), mins % 60);
  let day = dow - d.getUTCDay();
  if (day < 0) day += 7;
  let res = base + day * W;
  if (res < t) res += 7 * W;
  return res;
}

function cycleState(now: number, def: SessionDef) {
  const nextOpen = nextOccurrence(now, def.openD, def.openM);
  const prevOpen = nextOpen - 7 * W;
  const closeAfter = (openTs: number) => nextOccurrence(openTs, def.closeD, def.closeM);
  const prevClose = closeAfter(prevOpen);
  const isOpen = now >= prevOpen && now < prevClose;
  const closeAt = isOpen ? prevClose : closeAfter(nextOpen);
  return { isOpen, openAt: nextOpen, closeAt, nextEvent: isOpen ? closeAt : nextOpen, nextKind: (isOpen ? "CLOSES" : "OPENS") as "OPENS" | "CLOSES" };
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export default function SessionWidget() {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data: events } = useQuery({
    queryKey: ["session-calendar"],
    queryFn: () => apiGet<EconEvent[]>("/api/econ-calendar"),
    refetchInterval: 60_000,
  });

  const gold = cycleState(now, { label: "Gold", tz: "UTC", openD: 0, openM: 22 * 60, closeD: 5, closeM: 21 * 60 });

  const nextHigh = (events ?? [])
    .filter((e) => e.impact === "High" && new Date(e.date).getTime() > now)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const sessionTime = (instance: number) =>
    new Date(instance).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });

  return (
    <div className="p-2 text-[11px] space-y-1.5">
      <div className="flex items-center justify-between border-b border-[#161616] pb-1">
        <span className={`${gold.isOpen ? "up" : "dim"} font-bold`}>GOLD MARKET {gold.isOpen ? "OPEN" : "CLOSED"}</span>
        <span className="dim tabular-nums">
          {sessionTime(gold.nextEvent)} UTC · {fmtDur(gold.nextEvent - now)} {gold.nextKind}
        </span>
      </div>

      {SESSIONS.map((s) => {
        const st = cycleState(now, s);
        return (
          <div key={s.label} className="flex items-center gap-2">
            <span className={`w-16 ${st.isOpen ? "up" : "dim"}`}>{s.label}</span>
            <span className="dim w-16 tabular-nums">{s.tz}</span>
            <span className="dim flex-1 tabular-nums" title="Session window (UTC)">
              {hhmm(s.openM)}–{hhmm(s.closeM)}
            </span>
            <span className={`tabular-nums ${st.isOpen ? "up" : "dim"}`} key={st.nextEvent}>
              {st.nextEvent - now > 60_000 ? fmtDur(st.nextEvent - now) : "now"} {st.nextKind}
            </span>
          </div>
        );
      })}

      <div className="border-t border-[#161616] pt-1 flex items-center justify-between gap-2">
        {nextHigh ? (
          <>
            <span className="amber font-bold uppercase truncate" title={nextHigh.title}>
              {nextHigh.country} {nextHigh.title}
            </span>
            <span className="dim tabular-nums shrink-0">
              {new Date(nextHigh.date).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false })}Z ·{" "}
              {fmtDur(new Date(nextHigh.date).getTime() - now)}
            </span>
          </>
        ) : (
          <span className="dim">No high-impact events in this week&apos;s window.</span>
        )}
      </div>
    </div>
  );
}