interface GaugeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  warnAt?: number;
  dangerAt?: number;
  /** If set (e.g. from a DBC VAL_ table), shown instead of the raw number. */
  valueLabel?: string;
}

export default function Gauge({ label, value, min, max, unit, warnAt, dangerAt, valueLabel }: GaugeProps) {
  const clamped = Math.min(Math.max(value, min), max);
  const pct = (clamped - min) / (max - min);
  const angle = -120 + pct * 240;

  let color = "#22d3ee";
  if (dangerAt !== undefined && value >= dangerAt) color = "#f87171";
  else if (warnAt !== undefined && value >= warnAt) color = "#facc15";

  const radius = 70;
  const cx = 90;
  const cy = 90;
  const startAngle = -120;
  const endAngle = 120;

  const polarToXY = (deg: number) => {
    const rad = (deg - 90) * (Math.PI / 180);
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  };

  const [sx, sy] = polarToXY(startAngle);
  const [ex, ey] = polarToXY(endAngle);
  const [vx, vy] = polarToXY(angle);

  return (
    <div className="flex flex-col items-center rounded-xl bg-slate-900/60 border border-slate-800 p-4 shadow-inner">
      <svg width="180" height="130" viewBox="0 0 180 130">
        <path
          d={`M ${sx} ${sy} A ${radius} ${radius} 0 1 1 ${ex} ${ey}`}
          fill="none"
          stroke="#1e293b"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path
          d={`M ${sx} ${sy} A ${radius} ${radius} 0 ${pct > 0.625 ? 1 : 0} 1 ${vx} ${vy}`}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
        />
        <line x1={cx} y1={cy} x2={vx} y2={vy} stroke={color} strokeWidth="2" />
        <circle cx={cx} cy={cy} r="4" fill={color} />
        <text
          x={cx}
          y={cy + 24}
          textAnchor="middle"
          className="fill-slate-100"
          fontSize={valueLabel ? "14" : "20"}
          fontWeight="600"
        >
          {valueLabel ?? clamped.toFixed(0)}
        </text>
        <text x={cx} y={cy + 40} textAnchor="middle" className="fill-slate-500" fontSize="11">
          {unit}
        </text>
      </svg>
      <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">{label}</div>
    </div>
  );
}
