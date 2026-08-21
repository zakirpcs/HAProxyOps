import { useEffect, useMemo, useRef, useState } from "react";

export interface Series {
  name: string;
  /** [unix seconds, value]. A null value is a real gap and breaks the line. */
  points: [number, number | null][];
}

/**
 * Fixed categorical order. Never cycled and never extended: a seventh
 * generated hue is indistinguishable from an existing one under CVD, so the
 * server caps series with topk() and the tail is dropped rather than recoloured.
 */
export const SERIES_COLORS = [
  "var(--color-series-1)", "var(--color-series-2)", "var(--color-series-3)",
  "var(--color-series-4)", "var(--color-series-5)", "var(--color-series-6)",
] as const;

/**
 * Colour follows the entity, not its position.
 *
 * The panels use topk(), so series reorder between refetches as load shifts.
 * Assigning by array index would repaint the survivors and quietly break the
 * reader's "http-in is the blue one" - so a name keeps the slot it was first
 * given, for as long as the page is open.
 */
export function useSeriesColors(names: string[]): (name: string) => string {
  const assigned = useRef(new Map<string, number>());
  const key = names.join(" ");
  return useMemo(() => {
    const map = assigned.current;
    for (const name of names) {
      if (!map.has(name)) map.set(name, map.size % SERIES_COLORS.length);
    }
    return (name: string) => SERIES_COLORS[map.get(name) ?? 0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function formatValue(value: number, unit: string): string {
  if (unit === "bytes/s") {
    if (value < 1) return `${value.toFixed(2)} B/s`;
    const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
    const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  if (unit === "sessions") return Math.round(value).toLocaleString();
  if (value === 0) return "0";
  return value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString();
}

/** Round a maximum up to 1, 2, 5 x 10^n so the axis lands on readable ticks. */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalised = value / base;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * base;
}

const PAD = { top: 10, right: 14, bottom: 20, left: 52 };
const LABEL_GUTTER = 100;

interface Props {
  series: Series[];
  unit: string;
  height?: number;
  colorFor: (name: string) => string;
}

export default function TimeSeriesChart({ series, unit, height = 170, colorFor }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Direct labels become mandatory at 4 series, and only fit for a few; past
  // that the legend alone carries identity.
  const directLabels = series.length > 0 && series.length <= 4 && width > 380;
  const padRight = directLabels ? LABEL_GUTTER : PAD.right;

  const chart = useMemo(() => {
    const values = series
      .flatMap((s) => s.points.map(([, v]) => v))
      .filter((v): v is number => v !== null);
    const times = series.flatMap((s) => s.points.map(([t]) => t));
    if (times.length === 0) return null;

    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const yMax = niceMax(Math.max(...values, 0));
    const plotW = Math.max(1, width - PAD.left - padRight);
    const plotH = Math.max(1, height - PAD.top - PAD.bottom);

    const x = (t: number) => PAD.left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
    const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

    return { t0, t1, yMax, plotW, plotH, x, y };
  }, [series, width, height, padRight]);

  if (!chart) {
    return (
      <div ref={wrapper} style={{ height }}
           className="flex items-center justify-center text-xs text-[var(--color-mute)]">
        No data in this window.
      </div>
    );
  }

  const { t0, t1, yMax, plotW, plotH, x, y } = chart;
  const yTicks = [0, yMax / 2, yMax];
  const xTickCount = width < 420 ? 2 : 4;
  const xTicks = Array.from(
    { length: xTickCount + 1 }, (_, i) => t0 + ((t1 - t0) * i) / xTickCount);

  // Every series in a panel shares the query's timestamps, so one index
  // addresses all of them.
  const stamps = series[0]?.points.map(([t]) => t) ?? [];
  const hoverIndex = hoverX === null || stamps.length === 0
    ? null
    : stamps.reduce(
      (best, t, i) => (Math.abs(x(t) - hoverX) < Math.abs(x(stamps[best]) - hoverX) ? i : best),
      0,
    );

  function pathFor(points: Series["points"]): string {
    let d = "";
    let penDown = false;
    for (const [t, v] of points) {
      if (v === null) { penDown = false; continue; }
      d += `${penDown ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)} `;
      penDown = true;
    }
    return d.trim();
  }

  const endLabels = directLabels ? layoutLabels(series, y, PAD.top, plotH) : [];

  return (
    <div ref={wrapper} className="relative">
      <svg
        width="100%" height={height} role="img"
        aria-label={`Time series with ${series.length} series, measured in ${unit}`}
        onMouseMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onMouseLeave={() => setHoverX(null)}
      >
        {yTicks.map((value) => (
          <g key={value}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(value)} y2={y(value)}
                  stroke="var(--color-chart-grid)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(value) + 3} textAnchor="end"
                  fill="var(--color-mute)" fontSize={10}>
              {formatValue(value, unit)}
            </text>
          </g>
        ))}

        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6}
                textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                fill="var(--color-mute)" fontSize={10}>
            {new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </text>
        ))}

        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH}
              stroke="var(--color-chart-axis)" strokeWidth={1} />

        {series.map((s) => (
          <path key={s.name} d={pathFor(s.points)} fill="none" stroke={colorFor(s.name)}
                strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {endLabels.map((label) => (
          <g key={label.name}>
            <rect x={PAD.left + plotW + 6} y={label.labelY - 4} width={6} height={6} rx={1}
                  fill={colorFor(label.name)} />
            <text x={PAD.left + plotW + 16} y={label.labelY + 2} fontSize={10}
                  fill="var(--color-mute)">
              {truncate(label.name, 13)}
            </text>
          </g>
        ))}

        {hoverIndex !== null && (
          <g>
            <line x1={x(stamps[hoverIndex])} x2={x(stamps[hoverIndex])}
                  y1={PAD.top} y2={PAD.top + plotH}
                  stroke="var(--color-chart-axis)" strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s) => {
              const value = s.points[hoverIndex]?.[1];
              if (value === null || value === undefined) return null;
              return (
                <circle key={s.name} cx={x(stamps[hoverIndex])} cy={y(value)} r={4}
                        fill={colorFor(s.name)}
                        stroke="var(--color-ink-900)" strokeWidth={2} />
              );
            })}
          </g>
        )}
      </svg>

      {hoverIndex !== null && (
        <Tooltip series={series} index={hoverIndex} unit={unit} colorFor={colorFor}
                 left={x(stamps[hoverIndex])} width={width} time={stamps[hoverIndex]} />
      )}
    </div>
  );
}

/** Push end-labels apart so a tight cluster of lines stays readable. */
function layoutLabels(
  series: Series[],
  y: (v: number) => number,
  top: number,
  plotH: number,
): { name: string; labelY: number }[] {
  const MIN_GAP = 12;
  const entries = series
    .map((s) => {
      const last = [...s.points].reverse().find(([, v]) => v !== null);
      return last ? { name: s.name, labelY: y(last[1] as number) } : null;
    })
    .filter((e): e is { name: string; labelY: number } => e !== null)
    .sort((a, b) => a.labelY - b.labelY);

  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].labelY - entries[i - 1].labelY < MIN_GAP) {
      entries[i].labelY = entries[i - 1].labelY + MIN_GAP;
    }
  }
  const lowest = entries.at(-1)?.labelY ?? 0;
  const limit = top + plotH;
  if (lowest > limit) {
    const shift = lowest - limit;
    for (const entry of entries) entry.labelY -= shift;
  }
  return entries;
}

function Tooltip({ series, index, unit, colorFor, left, width, time }: {
  series: Series[]; index: number; unit: string; colorFor: (n: string) => string;
  left: number; width: number; time: number;
}) {
  const rows = series
    .map((s) => ({ name: s.name, value: s.points[index]?.[1] ?? null }))
    .filter((r): r is { name: string; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;

  const flip = left > width * 0.6;
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 rounded border border-ink-600 bg-ink-950/95 px-2 py-1.5 text-[11px] shadow-lg"
      style={flip ? { right: width - left + 10 } : { left: left + 10 }}
    >
      <div className="mb-1 text-[10px] text-[var(--color-mute)]">
        {new Date(time * 1000).toLocaleTimeString()}
      </div>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2 whitespace-nowrap">
          <span className="inline-block h-2 w-2 rounded-sm"
                style={{ background: colorFor(row.name) }} />
          <span className="text-slate-300">{row.name}</span>
          <span className="ml-auto pl-3 font-medium text-slate-100">
            {formatValue(row.value, unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Truncate from the middle, keeping both ends.
 *
 * Proxy names routinely share a prefix - "internal-api" and "internal-web"
 * both collapse to "internal..." from the right, which makes a direct label
 * worse than none. Keeping the tail is what disambiguates them.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
