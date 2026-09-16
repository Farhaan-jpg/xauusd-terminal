"use client";

import { useSyncExternalStore } from "react";

/** In-app alert tray + OS-level desktop notifications. The tray is a small
 *  feed of recent alerts surfaced from a bell in the TopBar; desktop
 *  notifications are opt-in via the browser's Notification permission. */

export type TrayItem = {
  id: string;
  text: string;
  tone: "up" | "down" | "amber";
  at: number;
};

const MAX_TRAY = 40;

let items: TrayItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getTray(): TrayItem[] {
  return items;
}

export function pushTray(text: string, tone: TrayItem["tone"]): void {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  items = [{ id, text, tone, at: Date.now() }, ...items].slice(0, MAX_TRAY);
  emit();
}

export function removeTrayItem(id: string): void {
  items = items.filter((i) => i.id !== id);
  emit();
}

export function clearTray(): void {
  items = [];
  emit();
}

export function subscribeTray(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTray(): TrayItem[] {
  return useSyncExternalStore(subscribeTray, getTray, getTray);
}

/** Ask for OS notification permission — must be called from a user gesture. */
export async function ensureNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

/** Fire a desktop notification if permission was granted. Never throws. */
export function osNotify(title: string, body: string): void {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag: `xauusd-${Date.now()}` });
    n.onclick = () => { window.focus(); n.close(); };
    // The browser closes chrome notifications for us; nothing else to do.
  } catch {
    // Notification constructor can throw in exotic embedded webviews — ignore.
  }
}