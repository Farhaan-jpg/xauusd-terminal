"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getOptions } from "../../lib/api";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#161616] px-2 py-1">
      <div className="dim text-[10px] uppercase tracking-wide">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

export default function OptionsWidget() {
  const { data } = useQuery({
    queryKey: ["options"],
    queryFn: () => getOptions(),
    refetchInterval: 60_000,
  });

  return (
    <div className="p-2 text-[11px]">
      <div className="dim text-[10px] mb-1.5">
        GC=F options · nearest expiry
        {data?.expiry ? ` · ${new Date(data.expiry * 1000).toISOString().slice(0, 10)}` : ""}
        {data?.underlying !== null && data?.underlying !== undefined ? ` · underlying ${fmt(data.underlying)}` : ""}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="ATM Strike" value={data?.atmStrike !== null && data?.atmStrike !== undefined ? fmt(data.atmStrike) : "—"} />
        <Stat label="ATM IV" value={data?.atmIv !== null && data?.atmIv !== undefined ? `${(data.atmIv * 100).toFixed(1)}%` : "—"} />
        <Stat label="Skew (RR proxy)" value={data?.skewProxy !== null && data?.skewProxy !== undefined ? `${(data.skewProxy * 100).toFixed(1)}%` : "—"} />
        <Stat label="P/C OI ratio" value={data?.putCallOiRatio !== null && data?.putCallOiRatio !== undefined ? fmt(data.putCallOiRatio, 2) : "—"} />
        <Stat label="Max OI strike" value={data?.maxOiStrike !== null && data?.maxOiStrike !== undefined ? fmt(data.maxOiStrike) : "—"} />
        <Stat label="Avg IV" value={data?.avgIv !== null && data?.avgIv !== undefined ? `${(data.avgIv * 100).toFixed(1)}%` : "—"} />
        <Stat label="Calls" value={String(data?.nCalls ?? 0)} />
        <Stat label="Puts" value={String(data?.nPuts ?? 0)} />
      </div>
      <div className="dim text-[10px] mt-1.5">
        Skew is an OTM-call − OTM-put IV proxy (no delta model). A positive number = calls rich (fear of upside), negative = puts rich.
      </div>
      {data && data.nCalls === 0 && data.nPuts === 0 && data.atmIv !== null && (
        <div className="dim text-[10px] mt-1">
          IV from the CBOE Gold Volatility Index (GVZ); full strike/OPI chain unavailable from this host.
        </div>
      )}
      {data && data.nCalls === 0 && data.nPuts === 0 && data.atmIv === null && (
        <div className="down text-[10px] mt-1">Options data temporarily unavailable — retrying…</div>
      )}
    </div>
  );
}