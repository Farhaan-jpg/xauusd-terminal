"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";

type EconEvent = {
  title: string;
  country: string;
  date: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};

const IMPACT_CLASS: Record<EconEvent["impact"], string> = {
  High: "down",
  Medium: "amber",
  Low: "dim",
  Holiday: "dim",
};

const TIMEZONES: Array<{ label: string; zone: string | undefined }> = [
  { label: "Local", zone: undefined },
  { label: "UTC", zone: "UTC" },
  { label: "New York", zone: "America/New_York" },
  { label: "London", zone: "Europe/London" },
  { label: "Frankfurt", zone: "Europe/Berlin" },
  { label: "Tokyo", zone: "Asia/Tokyo" },
];

export default function CalendarWidget() {
  const [minImpact, setMinImpact] = useState<"all" | "medium">("medium");
  const [tz, setTz] = useState<string>("Local");
  const [now, setNow] = useState<number | null>(null);

  // Tick so rows drop out the moment their scheduled time is past, instead of
  // hanging around until the next refetch. Null until mounted avoids a hydration
  // mismatch on the server-rendered snapshot.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["econ-calendar"],
    queryFn: () => apiGet<EconEvent[]>("/api/econ-calendar"),
    refetchInterval: 300_000,
  });

  const events = useMemo(() => {
    let list = minImpact === "all" ? data : data.filter((e) => e.impact === "High" || e.impact === "Medium");
    if (now !== null) list = list.filter((e) => new Date(e.date).getTime() > now);
    return list;
  }, [data, minImpact, now]);

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (isLoading) return <div className="p-2 dim">Loading calendar…</div>;

  const zone = TIMEZONES.find((t) => t.label === tz)?.zone;

  return (
    <div>
      <div className="flex gap-1 p-1 items-center flex-wrap">
        <button className={`term-btn ${minImpact === "medium" ? "active" : ""}`} onClick={() => setMinImpact("medium")}>
          HIGH+MED
        </button>
        <button className={`term-btn ${minImpact === "all" ? "active" : ""}`} onClick={() => setMinImpact("all")}>
          ALL
        </button>
        <span className="w-2" />
        <select
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          className="term-btn !py-0.5 bg-[var(--panel)] cursor-pointer"
        >
          {TIMEZONES.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ccy</th>
            <th>Event</th>
            <th>Forecast</th>
            <th>Previous</th>
            <th>Actual</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.title}-${e.date}-${i}`}>
              <td className="!text-left dim whitespace-nowrap">
                {new Date(e.date).toLocaleString(undefined, {
                  timeZone: zone,
                  month: "short",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </td>
              <td>{e.country}</td>
              <td className={`!text-left ${IMPACT_CLASS[e.impact]}`}>{e.title}</td>
              <td>{e.forecast ?? "—"}</td>
              <td className="dim">{e.previous ?? "—"}</td>
              <td className={e.actual ? "text-[var(--text)]" : "dim"}>{e.actual ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <div className="p-3 dim">No events in this window.</div>}
    </div>
  );
}