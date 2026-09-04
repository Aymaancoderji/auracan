import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import Gauge from "./components/Gauge";
import Chart, { SeriesPoint } from "./components/Chart";
import FrameLog from "./components/FrameLog";
import AlertLog from "./components/AlertLog";
import {
  DbcInfo,
  FlatSignal,
  RawFramePayload,
  StreamStatus,
  TelemetryPayload,
  flattenSignals,
} from "./lib/telemetry";
import { AlertEntry, levelFor, notifyDanger } from "./lib/alerts";
import { loadSettings, saveSettings } from "./lib/settings";

const MAX_POINTS = 120;
const MAX_FRAMES = 200;
const MIN_SLOTS = 1;
const MAX_SLOTS = 6;

const SLOT_COLORS = ["#22d3ee", "#facc15", "#a78bfa", "#34d399", "#fb7185", "#818cf8"];

const initialSettings = loadSettings();

function App() {
  const [interfaceName, setInterfaceName] = useState(initialSettings.interfaceName);
  const [availableInterfaces, setAvailableInterfaces] = useState<string[]>([]);
  const [baudRate, setBaudRate] = useState(initialSettings.baudRate);
  const [streaming, setStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState<{ attempt: number; maxAttempts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dbcPath, setDbcPath] = useState<string | null>(initialSettings.dbcPath);
  const [dbcInfo, setDbcInfo] = useState<DbcInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(initialSettings.soundEnabled);

  // Which signal (by raw name) drives each gauge/chart slot.
  const [slotSignals, setSlotSignals] = useState<(string | null)[]>(initialSettings.slotSignals);

  const [telemetry, setTelemetry] = useState<TelemetryPayload>({
    signals: {},
    bus_load_pct: 0,
    frame_count: 0,
    error_count: 0,
  });
  const [series, setSeries] = useState<SeriesPoint[][]>(() => initialSettings.slotSignals.map(() => []));
  const [frames, setFrames] = useState<RawFramePayload[]>([]);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const tRef = useRef(0);
  const levelsRef = useRef<Record<string, "normal" | "warning" | "danger">>({});

  const flatSignals: FlatSignal[] = useMemo(() => (dbcInfo ? flattenSignals(dbcInfo) : []), [dbcInfo]);

  const messageNameById = useMemo(() => {
    const map = new Map<number, string>();
    dbcInfo?.messages.forEach((m) => map.set(m.id, m.name));
    return map;
  }, [dbcInfo]);

  useEffect(() => {
    invoke<string[]>("list_can_interfaces")
      .then(setAvailableInterfaces)
      .catch(() => setAvailableInterfaces([]));
  }, []);

  // Re-load the last-used DBC on startup so slot selections (also
  // persisted) still resolve to real signals instead of showing blank
  // "Slot N" placeholders. If the file moved/was deleted, fail quietly —
  // the user can just pick a new one via "Load DBC".
  useEffect(() => {
    if (!initialSettings.dbcPath) return;
    invoke<DbcInfo>("load_dbc", { path: initialSettings.dbcPath })
      .then((info) => setDbcInfo(info))
      .catch(() => setDbcPath(null));
  }, []);

  // Persist dashboard settings (debounced isn't necessary — these change
  // rarely, not per telemetry tick).
  useEffect(() => {
    saveSettings({ interfaceName, baudRate, dbcPath, slotSignals, soundEnabled });
  }, [interfaceName, baudRate, dbcPath, slotSignals, soundEnabled]);

  useEffect(() => {
    const unlistenStreamStatus = listen<StreamStatus>("stream-status", (event) => {
      const status = event.payload;
      if (status.state === "reconnecting") {
        setReconnecting({ attempt: status.attempt, maxAttempts: status.max_attempts });
        return;
      }
      setReconnecting(null);
      setStreaming(false);
      setReplaying(false);
      if (status.state === "disconnected") {
        setError(`Connection lost: ${status.reason}`);
      } else {
        setNote("Replay finished.");
      }
    });

    return () => {
      unlistenStreamStatus.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlistenTelemetry = listen<TelemetryPayload>("telemetry-update", (event) => {
      const payload = event.payload;
      setTelemetry(payload);
      tRef.current += 1;
      const t = tRef.current;

      setSeries((prev) =>
        slotSignals.map((sigName, i) => {
          const v = sigName ? payload.signals[sigName] : undefined;
          if (v === undefined) return prev[i];
          const next = [...prev[i], { t, v }];
          return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
        })
      );

      const newAlerts: AlertEntry[] = [];
      const checkLevel = (key: string, label: string, value: number, unit: string, warnAt: number, dangerAt: number) => {
        const level = levelFor(value, warnAt, dangerAt);
        const prevLevel = levelsRef.current[key] ?? "normal";
        if (level === prevLevel) return;
        levelsRef.current[key] = level;
        const entryLevel = level === "normal" ? "cleared" : level;
        newAlerts.push({ id: `${Date.now()}-${key}-${level}`, time: Date.now(), label, level: entryLevel, value, unit });
        if (level === "danger") notifyDanger(label, value, unit, soundEnabled);
      };

      slotSignals.forEach((sigName, i) => {
        if (!sigName) return;
        const value = payload.signals[sigName];
        if (value === undefined) return;
        const sig = flatSignals.find((s) => s.name === sigName);
        const { min, max } = signalRange(sig);
        const label = sig ? `${sig.messageName}.${sig.name}` : `Slot ${i + 1}`;
        checkLevel(`slot-${i}`, label, value, sig?.unit ?? "", min + (max - min) * 0.75, min + (max - min) * 0.9);
      });
      checkLevel("bus-load", "Bus Load", payload.bus_load_pct, "%", 70, 90);

      if (newAlerts.length > 0) {
        setAlerts((prev) => [...newAlerts.reverse(), ...prev].slice(0, 200));
      }
    });

    const unlistenFrame = listen<RawFramePayload>("can-frame", (event) => {
      setFrames((prev) => {
        const next = [event.payload, ...prev];
        return next.length > MAX_FRAMES ? next.slice(0, MAX_FRAMES) : next;
      });
    });

    return () => {
      unlistenTelemetry.then((f) => f());
      unlistenFrame.then((f) => f());
    };
  }, [slotSignals, flatSignals, soundEnabled]);

  async function handleLoadDbc() {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "DBC", extensions: ["dbc"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const info = await invoke<DbcInfo>("load_dbc", { path: selected });
      setDbcPath(selected);
      setDbcInfo(info);
      const defaultNames = flattenSignals(info).map((s) => s.name);
      setSlotSignals((prev) => prev.map((_, i) => defaultNames[i] ?? null));
      setSeries((prev) => prev.map(() => []));
      levelsRef.current = {};
    } catch (e) {
      setError(String(e));
    }
  }

  function handleAddSlot() {
    setSlotSignals((prev) => (prev.length >= MAX_SLOTS ? prev : [...prev, null]));
    setSeries((prev) => (prev.length >= MAX_SLOTS ? prev : [...prev, []]));
  }

  function handleRemoveSlot(slot: number) {
    setSlotSignals((prev) => (prev.length <= MIN_SLOTS ? prev : prev.filter((_, i) => i !== slot)));
    setSeries((prev) => (prev.length <= MIN_SLOTS ? prev : prev.filter((_, i) => i !== slot)));
    // Indices shift after a removal, so per-slot alert level tracking (keyed
    // by index) would otherwise misattribute stale levels to the wrong slot.
    levelsRef.current = Object.fromEntries(
      Object.entries(levelsRef.current).filter(([key]) => !key.startsWith("slot-"))
    );
  }

  async function handleStart() {
    setError(null);
    setNote(null);
    try {
      await invoke("start_can_stream", { interfaceName, baudRate });
      setStreaming(true);
      setReplaying(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_can_stream");
    } finally {
      setStreaming(false);
      setReplaying(false);
      setReconnecting(null);
    }
  }

  async function handleToggleRecording() {
    setError(null);
    if (recording) {
      try {
        await invoke("stop_recording");
      } finally {
        setRecording(false);
      }
      return;
    }
    try {
      const path = await save({ filters: [{ name: "CAN Log", extensions: ["log"] }] });
      if (!path) return;
      await invoke("start_recording", { path, interface: interfaceName });
      setRecording(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleReplay() {
    setError(null);
    setNote(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CAN Log", extensions: ["log"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await invoke("start_replay", { path: selected, baudRate, speed: 1.0 });
      setStreaming(true);
      setReplaying(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleSlotChange(slot: number, name: string) {
    setSlotSignals((prev) => {
      const next = [...prev];
      next[slot] = name || null;
      return next;
    });
    setSeries((prev) => {
      const next = [...prev];
      next[slot] = [];
      return next;
    });
    delete levelsRef.current[`slot-${slot}`];
  }

  function signalRange(sig: FlatSignal | undefined) {
    if (!sig || (sig.min === 0 && sig.max === 0)) {
      return { min: 0, max: 100 };
    }
    return { min: sig.min, max: sig.max };
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AuraCAN</h1>
            <p className="text-xs text-slate-500">Real-Time SocketCAN Telemetry Engine</p>
          </div>
          <span
            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border ${
              reconnecting
                ? "text-yellow-300 border-yellow-800 bg-yellow-950/40"
                : streaming
                ? "text-emerald-300 border-emerald-800 bg-emerald-950/40"
                : "text-slate-500 border-slate-800 bg-slate-900"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                reconnecting
                  ? "bg-yellow-400 animate-pulse"
                  : streaming
                  ? "bg-emerald-400 animate-pulse"
                  : "bg-slate-600"
              }`}
            />
            {reconnecting ? "Reconnecting" : streaming ? (replaying ? "Replaying" : "Streaming") : "Idle"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundEnabled((v) => !v)}
            title={soundEnabled ? "Mute danger-alert sound" : "Unmute danger-alert sound"}
            aria-label={soundEnabled ? "Mute alert sound" : "Unmute alert sound"}
            className={`text-sm font-medium px-3 py-1.5 rounded-md ${
              soundEnabled
                ? "bg-slate-800 hover:bg-slate-700 text-slate-100"
                : "bg-slate-900 hover:bg-slate-800 text-slate-500 border border-slate-800"
            }`}
          >
            {soundEnabled ? "Sound On" : "Muted"}
          </button>
          <button
            onClick={handleLoadDbc}
            disabled={streaming}
            className="bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium px-3 py-1.5 rounded-md disabled:opacity-50"
          >
            {dbcInfo ? `DBC: ${dbcInfo.messages.length} msgs` : "Load DBC"}
          </button>
          <input
            className="bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-sm w-24"
            value={interfaceName}
            onChange={(e) => setInterfaceName(e.target.value)}
            disabled={streaming}
            list="can-interfaces"
            placeholder="vcan0"
          />
          <datalist id="can-interfaces">
            {availableInterfaces.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <input
            className="bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-sm w-28"
            type="number"
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={streaming}
          />
          <button
            onClick={handleToggleRecording}
            disabled={replaying}
            title={replaying ? "Can't record while replaying" : "Record raw frames to a .log file"}
            className={`text-sm font-medium px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${
              recording
                ? "bg-red-900/60 hover:bg-red-900 text-red-200 border border-red-800"
                : "bg-slate-800 hover:bg-slate-700 text-slate-100"
            }`}
          >
            {recording ? "● Recording" : "Record"}
          </button>
          <button
            onClick={handleReplay}
            disabled={streaming || !dbcPath}
            title={!dbcPath ? "Load a .dbc file first" : undefined}
            className="bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Replay Log…
          </button>
          {!streaming ? (
            <button
              onClick={handleStart}
              disabled={!dbcPath}
              title={!dbcPath ? "Load a .dbc file first" : undefined}
              className="bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium px-4 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="bg-red-600 hover:bg-red-500 text-white text-sm font-medium px-4 py-1.5 rounded-md"
            >
              Stop
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-300 leading-none"
          >
            ×
          </button>
        </div>
      )}

      {note && (
        <div className="mb-4 flex items-start justify-between gap-3 text-sm text-cyan-300 bg-cyan-950/40 border border-cyan-900 rounded-md px-3 py-2">
          <span>{note}</span>
          <button
            onClick={() => setNote(null)}
            aria-label="Dismiss notice"
            className="text-cyan-500 hover:text-cyan-200 leading-none"
          >
            ×
          </button>
        </div>
      )}

      {reconnecting && (
        <div className="mb-4 text-sm text-yellow-400 bg-yellow-950/40 border border-yellow-900 rounded-md px-3 py-2">
          Connection to {interfaceName} lost. Reconnecting… (attempt {reconnecting.attempt}/
          {reconnecting.maxAttempts})
        </div>
      )}

      {dbcInfo && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 mb-2">
          {slotSignals.map((sigName, i) => (
            <div key={i} className="flex items-center gap-1">
              <select
                value={sigName ?? ""}
                onChange={(e) => handleSlotChange(i, e.target.value)}
                className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-xs text-slate-300"
              >
                <option value="">— none —</option>
                {flatSignals.map((sig) => (
                  <option
                    key={`${sig.messageId}.${sig.name}`}
                    value={sig.name}
                    title={sig.description ?? undefined}
                  >
                    {sig.messageName}.{sig.name} {sig.unit ? `(${sig.unit})` : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleRemoveSlot(i)}
                disabled={slotSignals.length <= MIN_SLOTS}
                title="Remove slot"
                className="text-slate-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed px-1"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={handleAddSlot}
            disabled={slotSignals.length >= MAX_SLOTS}
            className="border border-dashed border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500 rounded-md px-2 py-1 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
          >
            + Add slot
          </button>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4 mb-4">
        {slotSignals.map((sigName, i) => {
          const sig = flatSignals.find((s) => s.name === sigName);
          const { min, max } = signalRange(sig);
          const value = sigName ? telemetry.signals[sigName] ?? 0 : 0;
          const valueLabel = sig?.value_table[String(Math.trunc(value))];
          return (
            <Gauge
              key={i}
              label={sig ? `${sig.messageName}.${sig.name}` : `Slot ${i + 1}`}
              value={value}
              min={min}
              max={max}
              unit={sig?.unit ?? ""}
              warnAt={min + (max - min) * 0.75}
              dangerAt={min + (max - min) * 0.9}
              valueLabel={valueLabel}
            />
          );
        })}
        <Gauge
          label="Bus Load"
          value={telemetry.bus_load_pct}
          min={0}
          max={100}
          unit="%"
          warnAt={70}
          dangerAt={90}
        />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 mb-4">
        {slotSignals.map((sigName, i) => {
          const sig = flatSignals.find((s) => s.name === sigName);
          return (
            <Chart
              key={i}
              title={sig ? `${sig.messageName}.${sig.name}` : `Slot ${i + 1}`}
              color={SLOT_COLORS[i % SLOT_COLORS.length]}
              points={series[i]}
              unit={sig?.unit ?? ""}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-4 h-64">
        <div className="col-span-2 h-full">
          <FrameLog frames={frames} messageNameById={messageNameById} />
        </div>
        <AlertLog alerts={alerts} />
      </div>

      <footer className="mt-4 text-xs text-slate-600 flex gap-4">
        <span>Frames: {telemetry.frame_count}</span>
        <span>Errors: {telemetry.error_count}</span>
        <span>
          Status: {reconnecting ? "reconnecting" : streaming ? (replaying ? "replaying" : "streaming") : "idle"}
        </span>
      </footer>
    </div>
  );
}

export default App;
