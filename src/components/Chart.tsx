import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

export interface SeriesPoint {
  t: number;
  v: number;
}

interface ChartProps {
  title: string;
  color: string;
  points: SeriesPoint[];
  unit: string;
}

export default function Chart({ title, color, points, unit }: ChartProps) {
  const data = {
    labels: points.map((p) => p.t),
    datasets: [
      {
        label: `${title} (${unit})`,
        data: points.map((p) => p.v),
        borderColor: color,
        backgroundColor: color + "33",
        pointRadius: 0,
        tension: 0.25,
        borderWidth: 2,
      },
    ],
  };

  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">{title}</div>
      <div className="h-40">
        <Line
          data={data}
          options={{
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { display: false },
              y: {
                ticks: { color: "#94a3b8", font: { size: 10 } },
                grid: { color: "#1e293b" },
              },
            },
            plugins: { legend: { display: false } },
          }}
        />
      </div>
    </div>
  );
}
