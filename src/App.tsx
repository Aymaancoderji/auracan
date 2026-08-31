import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Gauge from "./components/Gauge";
import Chart, { SeriesPoint } from "./components/Chart";
import FrameLog from "./components/FrameLog";
import {
  DbcInfo,
  FlatSignal,
  RawFramePayload,
  TelemetryPayload,
  flattenSignals,
} from "./lib/telemetry";

const MAX_POINTS = 120;
const MAX_FRAMES = 200;

const SLOT_COLORS = ["#22d3ee", "#facc15", "#a78bfa"];

function App() {
  const [interfaceName, setInterfaceName] = useState("vcan0");
  const [baudRate, setBaudRate] = useState(500000);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [dbcInfo, setDbcInfo] = useState<DbcInfo | null>(null);

  // Which signal (by raw name) drives each of the three gauge/chart slots.
  const [slotSignals, setSlotSignals] = useState<(string | null)[]>([null, null, null]);

  const [telemetry, setTelemetry] = useState<TelemetryPayload>({
    signals: {},
    bus_load_pct: 0,
    frame_count: 0,
    error_count: 0,
  });
  const [series, setSeries] = useState<SeriesPoint[][]>([[], [], []]);
  const [frames, setFrames] = useState<RawFramePayload[]>([]);
  const tRef = useRef(0);

  const flatSignals: FlatSignal[] = useMemo(() => (dbcInfo ? flattenSignals(dbcInfo) : []), [dbcInfo]);

  const messageNameById = useMemo(() => {
    const map = new Map<number, string>();
    dbcInfo?.messages.forEach((m) => map.set(m.id, m.name));
    return map;
  }, [dbcInfo]);

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
  }, [slotSignals]);

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
      const defaults = flattenSignals(info)
        .slice(0, 3)
        .map((s) => s.name);
      setSlotSignals([defaults[0] ?? null, defaults[1] ?? null, defaults[2] ?? null]);
      setSeries([[], [], []]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStart() {
    setError(null);
    try {
      await invoke("start_can_stream", { interfaceName, baudRate });
      setStreaming(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_can_stream");
    } finally {
      setStreaming(false);
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
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AuraCAN</h1>
          <p className="text-xs text-slate-500">Real-Time SocketCAN Telemetry Engine</p>
        </div>
        <div className="flex items-center gap-2">
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
          />
          <input
            className="bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-sm w-28"
            type="number"
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={streaming}
          />
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
        <div className="mb-4 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {dbcInfo && (
        <div className="grid grid-cols-3 gap-4 mb-2">
          {slotSignals.map((sigName, i) => (
            <select
              key={i}
              value={sigName ?? ""}
              onChange={(e) => handleSlotChange(i, e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-xs text-slate-300"
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
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-4">
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

      <div className="grid grid-cols-3 gap-4 mb-4">
        {slotSignals.map((sigName, i) => {
          const sig = flatSignals.find((s) => s.name === sigName);
          return (
            <Chart
              key={i}
              title={sig ? `${sig.messageName}.${sig.name}` : `Slot ${i + 1}`}
              color={SLOT_COLORS[i]}
              points={series[i]}
              unit={sig?.unit ?? ""}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 h-64">
        <FrameLog frames={frames} messageNameById={messageNameById} />
      </div>

      <footer className="mt-4 text-xs text-slate-600 flex gap-4">
        <span>Frames: {telemetry.frame_count}</span>
        <span>Errors: {telemetry.error_count}</span>
        <span>Status: {streaming ? "streaming" : "idle"}</span>
      </footer>
    </div>
  );
}

export default App;
