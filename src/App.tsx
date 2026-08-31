import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Gauge from "./components/Gauge";
import Chart, { SeriesPoint } from "./components/Chart";
import FrameLog from "./components/FrameLog";
import { RawFramePayload, TelemetryPayload } from "./lib/telemetry";

const MAX_POINTS = 120;
const MAX_FRAMES = 200;

function App() {
  const [interfaceName, setInterfaceName] = useState("vcan0");
  const [baudRate, setBaudRate] = useState(500000);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [dbcMessageCount, setDbcMessageCount] = useState<number | null>(null);

  const [telemetry, setTelemetry] = useState<TelemetryPayload>({
    signals: {},
    bus_load_pct: 0,
    frame_count: 0,
    error_count: 0,
  });
  const [rpmSeries, setRpmSeries] = useState<SeriesPoint[]>([]);
  const [tempSeries, setTempSeries] = useState<SeriesPoint[]>([]);
  const [currentSeries, setCurrentSeries] = useState<SeriesPoint[]>([]);
  const [frames, setFrames] = useState<RawFramePayload[]>([]);
  const tRef = useRef(0);

  useEffect(() => {
    const unlistenTelemetry = listen<TelemetryPayload>("telemetry-update", (event) => {
      const payload = event.payload;
      setTelemetry(payload);
      tRef.current += 1;
      const t = tRef.current;

      const push = (setter: React.Dispatch<React.SetStateAction<SeriesPoint[]>>, v: number | undefined) => {
        if (v === undefined) return;
        setter((prev) => {
          const next = [...prev, { t, v }];
          return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
        });
      };

      push(setRpmSeries, payload.signals["MotorRPM"]);
      push(setTempSeries, payload.signals["ControllerTemp"]);
      push(setCurrentSeries, payload.signals["OutputCurrent"]);
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
  }, []);

  async function handleLoadDbc() {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "DBC", extensions: ["dbc"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const count = await invoke<number>("load_dbc", { path: selected });
      setDbcPath(selected);
      setDbcMessageCount(count);
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

  const rpm = telemetry.signals["MotorRPM"] ?? 0;
  const temp = telemetry.signals["ControllerTemp"] ?? 0;
  const current = telemetry.signals["OutputCurrent"] ?? 0;

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
            {dbcPath ? `DBC: ${dbcMessageCount} msgs` : "Load DBC"}
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

      <div className="grid grid-cols-4 gap-4 mb-4">
        <Gauge label="Motor RPM" value={rpm} min={0} max={8000} unit="rpm" warnAt={6000} dangerAt={7500} />
        <Gauge label="Controller Temp" value={temp} min={-40} max={150} unit="°C" warnAt={90} dangerAt={110} />
        <Gauge label="Output Current" value={current} min={0} max={400} unit="A" warnAt={300} dangerAt={360} />
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
        <Chart title="Motor RPM" color="#22d3ee" points={rpmSeries} unit="rpm" />
        <Chart title="Controller Temp" color="#facc15" points={tempSeries} unit="°C" />
        <Chart title="Output Current" color="#a78bfa" points={currentSeries} unit="A" />
      </div>

      <div className="grid grid-cols-1 gap-4 h-64">
        <FrameLog frames={frames} />
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
