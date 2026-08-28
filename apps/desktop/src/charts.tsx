// The dashboard's charts, drawn as plain SVG. The design used Plotly from a
// CDN; the packaged app runs offline inside the Tauri webview, so the two
// charts it actually needs (projection area, allocation donut) are drawn here.

const GRID = "rgba(45,55,72,0.45)";
const AXIS = "#6b7280";
const GREEN = "#10b981";

function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

/**
 * The Yield Horizon area chart: a compound-growth projection line from
 * today's net worth, with a widening uncertainty band above it, on a
 * dark grid. Pure function of (base, rate, span).
 */
export function HorizonChart({ base, rate, yearStart, yearEnd, height = 200 }: { base: number; rate: number; yearStart: number; yearEnd: number; height?: number }) {
  const W = 1000;
  const H = height;
  const ml = 56;
  const mr = 12;
  const mt = 10;
  const mb = 24;
  const n = 60;
  const span = yearEnd - yearStart;
  const ys: number[] = [];
  const upper: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * span;
    const v = base * Math.pow(1 + rate, t);
    ys.push(v);
    upper.push(v * (1 + 0.12 * Math.sqrt(t / span)));
  }
  const yMax = Math.max(...upper) * 1.08;
  const yMin = 0;
  const px = (i: number) => ml + (i / n) * (W - ml - mr);
  const py = (v: number) => mt + (1 - (v - yMin) / (yMax - yMin)) * (H - mt - mb);
  const line = ys.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  const bandPath =
    ys.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("") +
    [...upper].reverse().map((v, j) => `L${px(n - j).toFixed(1)},${py(v).toFixed(1)}`).join("") +
    "Z";
  const fillPath = line + `L${px(n).toFixed(1)},${py(0).toFixed(1)}L${px(0).toFixed(1)},${py(0).toFixed(1)}Z`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const xTicks: number[] = [];
  for (let y = yearStart; y <= yearEnd; y += 2) xTicks.push(y);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} aria-hidden="true">
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={ml} x2={W - mr} y1={py(v)} y2={py(v)} stroke={GRID} strokeWidth="1" />
          <text x={ml - 8} y={py(v) + 3} textAnchor="end" fontSize="11" fill={AXIS}>{compact(v)}</text>
        </g>
      ))}
      {xTicks.map((y) => {
        const x = ml + ((y - yearStart) / span) * (W - ml - mr);
        return (
          <g key={y}>
            <line x1={x} x2={x} y1={mt} y2={H - mb} stroke={GRID} strokeWidth="0.5" />
            <text x={x} y={H - 8} textAnchor="middle" fontSize="11" fill={AXIS}>{y}</text>
          </g>
        );
      })}
      <path d={bandPath} fill="rgba(16,185,129,0.16)" />
      <path d={fillPath} fill="rgba(16,185,129,0.07)" />
      <path d={line} fill="none" stroke={GREEN} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export interface DonutSlice { label: string; value: number; color: string }

/** The allocation donut: one ring, slices by market value, hollow center. */
export function DonutChart({ slices, size = 180 }: { slices: DonutSlice[]; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  const r = 42;
  const cx = 50;
  const cy = 50;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size, display: "block" }} aria-hidden="true">
      {slices.filter((s) => s.value > 0).map((s) => {
        const frac = s.value / total;
        const el = (
          <circle
            key={s.label}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth="12"
            strokeDasharray={`${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`}
            strokeDashoffset={(-offset * C + C / 4).toFixed(2)}
          />
        );
        offset += frac;
        return el;
      })}
    </svg>
  );
}
