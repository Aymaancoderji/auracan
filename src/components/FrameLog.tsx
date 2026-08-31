import { RawFramePayload, formatBytes, formatHex } from "../lib/telemetry";

interface FrameLogProps {
  frames: RawFramePayload[];
}

export default function FrameLog({ frames }: FrameLogProps) {
  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4 flex flex-col h-full">
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Raw Frame Inspector</div>
      <div className="overflow-y-auto flex-1 font-mono text-xs">
        <table className="w-full text-left">
          <thead className="text-slate-500 sticky top-0 bg-slate-900/90">
            <tr>
              <th className="pr-3 py-1">ID</th>
              <th className="pr-3 py-1">DLC</th>
              <th className="pr-3 py-1">Data</th>
              <th className="pr-3 py-1">Δt (µs)</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((f, i) => {
              const prev = frames[i + 1];
              const delta = prev ? f.timestamp_us - prev.timestamp_us : 0;
              return (
                <tr key={`${f.timestamp_us}-${i}`} className="border-t border-slate-800/60 text-slate-300">
                  <td className="pr-3 py-1 text-cyan-400">{formatHex(f.id, f.is_extended)}</td>
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
