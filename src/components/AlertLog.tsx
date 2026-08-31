import { AlertEntry } from "../lib/alerts";

interface AlertLogProps {
  alerts: AlertEntry[];
}

const LEVEL_STYLES: Record<AlertEntry["level"], string> = {
  danger: "text-red-400",
  warning: "text-yellow-400",
  cleared: "text-slate-500",
};

export default function AlertLog({ alerts }: AlertLogProps) {
  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4 flex flex-col h-full">
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Alerts</div>
      <div className="overflow-y-auto flex-1 font-mono text-xs space-y-1">
        {alerts.length === 0 && <div className="text-slate-600">No alerts yet.</div>}
        {alerts.map((a) => (
          <div key={a.id} className={LEVEL_STYLES[a.level]}>
            <span className="text-slate-600">{new Date(a.time).toLocaleTimeString()}</span>{" "}
            {a.label} {a.level === "cleared" ? "cleared" : `entered ${a.level.toUpperCase()}`} (
            {a.value.toFixed(1)}
            {a.unit})
          </div>
        ))}
      </div>
    </div>
  );
}
