"use client";

import { useEffect } from "react";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Workspace from "./Workspace";
import Ticker from "./Ticker";
import { unlockAudio } from "../lib/sounds";
import { useAlerts } from "../lib/useAlerts";
import { ensureNotifyPermission } from "../lib/notify";
import { useTerminal } from "../store/terminal";

export default function Terminal() {
  const addWidget = useTerminal((s) => s.addWidget);
  const banner = useAlerts();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) {
        const map: Record<string, () => void> = {
          "1": () => addWidget("chart"),
          "2": () => addWidget("quote"),
          "3": () => addWidget("levels"),
          "4": () => addWidget("correlations"),
          "5": () => addWidget("news"),
          "6": () => addWidget("calendar"),
          "7": () => addWidget("ai"),
          "8": () => addWidget("bias"),
          "9": () => addWidget("session"),
        };
        const fn = map[e.key];
        if (fn) {
          e.preventDefault();
          fn();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addWidget]);

  // WebAudio needs a user gesture before it can play; unlock on first input.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // OS notifications also require a user gesture for the permission prompt —
  // request it on the first click anywhere (non-blocking; Chromium shows an
  // info-bar the user can accept or ignore).
  useEffect(() => {
    const arm = () => { void ensureNotifyPermission(); };
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, []);

  return (
    <div className="flex flex-col h-screen relative">
      <TopBar />
      <div className="term-body flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="term-main flex-1 overflow-auto flex flex-col">
          <Ticker />
          <div className="flex-1 min-h-0">
            <Workspace />
          </div>
        </main>
      </div>
      {banner && (
        <div
          key={banner.key}
          className={`${banner.tone} fixed top-10 left-1/2 -translate-x-1/2 z-[100] bg-[var(--panel-2)] border border-[var(--border)] px-4 py-2 text-[12px] font-bold tracking-wider shadow-lg`}
        >
          {banner.text}
        </div>
      )}
    </div>
  );
}