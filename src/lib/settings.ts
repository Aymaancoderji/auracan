const STORAGE_KEY = "auracan.settings.v1";

export interface PersistedSettings {
  interfaceName: string;
  baudRate: number;
  dbcPath: string | null;
  slotSignals: (string | null)[];
}

const DEFAULTS: PersistedSettings = {
  interfaceName: "vcan0",
  baudRate: 500000,
  dbcPath: null,
  slotSignals: [null, null, null],
};

/** Loads persisted dashboard settings from localStorage, falling back to defaults for anything missing or malformed. */
export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      interfaceName: typeof parsed.interfaceName === "string" ? parsed.interfaceName : DEFAULTS.interfaceName,
      baudRate: typeof parsed.baudRate === "number" ? parsed.baudRate : DEFAULTS.baudRate,
      dbcPath: typeof parsed.dbcPath === "string" ? parsed.dbcPath : null,
      slotSignals: Array.isArray(parsed.slotSignals) ? parsed.slotSignals : DEFAULTS.slotSignals,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persists dashboard settings to localStorage. Silently no-ops if storage is unavailable (private browsing quirks, etc). */
export function saveSettings(settings: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/unavailable — settings just won't survive a reload.
  }
}
