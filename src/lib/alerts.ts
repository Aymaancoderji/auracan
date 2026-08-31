export type AlertLevel = "warning" | "danger";

export interface AlertEntry {
  id: string;
  time: number;
  label: string;
  level: AlertLevel | "cleared";
  value: number;
  unit: string;
}

/** Classifies `value` against a gauge's warn/danger thresholds, matching Gauge's own coloring logic. */
export function levelFor(value: number, warnAt?: number, dangerAt?: number): AlertLevel | "normal" {
  if (dangerAt !== undefined && value >= dangerAt) return "danger";
  if (warnAt !== undefined && value >= warnAt) return "warning";
  return "normal";
}

let audioCtx: AudioContext | null = null;

/** A short synthesized beep — no audio asset needed, works offline. */
function beep() {
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch {
    // Web Audio unavailable (no user gesture yet, unsupported environment, etc.) — skip the beep.
  }
}

/** Beeps and, if permitted, raises a desktop notification for a danger-level alert. */
export function notifyDanger(label: string, value: number, unit: string) {
  beep();

  if (typeof Notification === "undefined") return;
  const body = `${label}: ${value.toFixed(1)}${unit}`;
  if (Notification.permission === "granted") {
    new Notification("AuraCAN alert", { body });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission()
      .then((perm) => {
        if (perm === "granted") {
          new Notification("AuraCAN alert", { body });
        }
      })
      .catch(() => {});
  }
}
