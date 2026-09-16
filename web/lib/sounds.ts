"use client";

let ctx: AudioContext | null = null;
let unlocked = false;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Call from any user gesture once so autoplay policies allow later sounds. */
export function unlockAudio(): void {
  if (unlocked) return;
  try {
    const c = ensureCtx();
    if (c) void c.resume();
    unlocked = true;
  } catch {
    // no-op
  }
}

/**
 * Alert beep: two quick ascending tones (a "bing-bong") appropriate for a
 * major gold move or a high-impact calendar event.
 */
export function playAlertSound(volume = 0.5): void {
  try {
    const c = ensureCtx();
    if (!c) return;
    const now = c.currentTime;
    const play = (freq: number, start: number, dur: number) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(volume, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };
    play(880, 0, 0.22);
    play(1320, 0.18, 0.28);
  } catch {
    // no-op
  }
}