import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { RawFramePayload, formatBytes, formatHex, framesToCsv } from "../lib/telemetry";

interface FrameLogProps {
  frames: RawFramePayload[];
  messageNameById: Map<number, string>;
}

export default function FrameLog({ frames, messageNameById }: FrameLogProps) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return frames;
    return frames.filter((f) => {
      const hex = formatHex(f.id, f.is_extended).toLowerCase();
      const name = (messageNameById.get(f.id) ?? "").toLowerCase();
      return hex.includes(q) || name.includes(q) || String(f.id).includes(q);
    });
  }, [frames, filter, messageNameById]);

  async function handleExportCsv() {
    const path = await save({ filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    await invoke("export_csv", { path, contents: framesToCsv(filtered, messageNameById) });
  }

  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wide text-slate-400">Raw Frame Inspector</div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by ID or message name…"
            className="bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-xs w-56"
          />
          <button
            onClick={handleExportCsv}
            disabled={frames.length === 0}
            title="Export the frames currently shown as CSV"
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium px-2 py-1 rounded-md disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 font-mono text-xs">
        <table className="w-full text-left">
          <thead className="text-slate-500 sticky top-0 bg-slate-900/90">
            <tr>
              <th className="pr-3 py-1">ID</th>
              <th className="pr-3 py-1">Message</th>
              <th className="pr-3 py-1">DLC</th>
              <th className="pr-3 py-1">Data</th>
              <th className="pr-3 py-1">Δt (µs)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f, i) => {
              const prev = filtered[i + 1];
              const delta = prev ? f.timestamp_us - prev.timestamp_us : 0;
              return (
                <tr key={`${f.timestamp_us}-${i}`} className="border-t border-slate-800/60 text-slate-300">
                  <td className="pr-3 py-1 text-cyan-400">{formatHex(f.id, f.is_extended)}</td>
                  <td className="pr-3 py-1 text-slate-400">{messageNameById.get(f.id) ?? ""}</td>
                  <td className="pr-3 py-1">{f.dlc}</td>
                  <td className="pr-3 py-1">{formatBytes(f.data, f.dlc)}</td>
                  <td className="pr-3 py-1 text-slate-500">{delta}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
