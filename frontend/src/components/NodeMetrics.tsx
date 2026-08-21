import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Panel } from "./ui";
import TimeSeriesChart, {
  formatValue, useSeriesColors, type Series,
} from "./TimeSeriesChart";

interface MetricPanel {
  key: string;
  title: string;
  unit: string;
  description: string;
  series: Series[];
}

const RANGES = [
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
  { minutes: 360, label: "6h" },
  { minutes: 1440, label: "24h" },
];

const STORAGE_KEY = "haproxyops.metricsRange";

export default function NodeMetrics({ nodeId }: { nodeId: number }) {
  const [minutes, setMinutes] = useState(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return RANGES.some((r) => r.minutes === saved) ? saved : 60;
  });
  const [showTable, setShowTable] = useState(false);

  const enabled = useQuery({
    queryKey: ["metrics-status"],
    queryFn: api.metricsStatus,
    staleTime: 5 * 60_000,
  });

  const metrics = useQuery({
    queryKey: ["metrics", nodeId, minutes],
    queryFn: () => api.nodeMetrics(nodeId, minutes),
    enabled: enabled.data?.enabled === true,
    // Prometheus scrapes on its own schedule; refetching faster shows nothing new.
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => localStorage.setItem(STORAGE_KEY, String(minutes)), [minutes]);

  // Graphs are optional: with no Prometheus configured, say so once and stop.
  if (enabled.isLoading || enabled.data?.enabled === false) {
    if (enabled.isLoading) return null;
    return (
      <Panel title="Metrics">
        <p className="text-sm text-[var(--color-mute)]">
          No Prometheus configured. Set <code className="text-slate-300">
          HAPROXYOPS_PROMETHEUS_URL</code> on the API to enable graphs — HAProxy 2.0+
          already serves the exporter on its stats port, so nothing needs installing
          on the nodes.
        </p>
      </Panel>
    );
  }

  const panels: MetricPanel[] = metrics.data?.panels ?? [];

  return (
    <Panel
      title="Metrics"
      actions={
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((range) => (
            <button
              key={range.minutes}
              type="button"
              onClick={() => setMinutes(range.minutes)}
              aria-pressed={minutes === range.minutes}
              className={`rounded border px-2 py-0.5 text-xs transition ${
                minutes === range.minutes
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "border-ink-600 bg-ink-800 text-[var(--color-mute)] hover:text-slate-200"
              }`}
            >
              {range.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            title="Show the underlying numbers instead of the plots"
            className={`ml-2 rounded border px-2 py-0.5 text-xs transition ${
              showTable
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "border-ink-600 bg-ink-800 text-[var(--color-mute)] hover:text-slate-200"
            }`}
          >
            Table
          </button>
        </div>
      }
    >
      {metrics.isError && (
        <p className="rounded border border-[var(--color-drain)]/40 bg-[var(--color-drain)]/10 px-3 py-2 text-sm text-[var(--color-drain)]">
          {(metrics.error as Error).message}
        </p>
      )}

      {metrics.isLoading && (
        <p className="text-sm text-[var(--color-mute)]">Loading metrics…</p>
      )}

      {panels.length > 0 && (
        <div className="grid gap-3 sm:gap-4 xl:grid-cols-2">
          {panels.map((panel) => (
            <MetricCard key={panel.key} panel={panel} showTable={showTable} />
          ))}
        </div>
      )}

      {!metrics.isLoading && !metrics.isError && panels.length === 0 && (
        <p className="text-sm text-[var(--color-mute)]">
          No metrics for this node. Check that Prometheus is scraping it, and that the
          node&rsquo;s <code className="text-slate-300">prometheus_instance</code> matches
          the scrape target.
        </p>
      )}
    </Panel>
  );
}

function MetricCard({ panel, showTable }: { panel: MetricPanel; showTable: boolean }) {
  const names = panel.series.map((s) => s.name);
  const colorFor = useSeriesColors(names);

  const latest = panel.series.map((s) => {
    const last = [...s.points].reverse().find(([, v]) => v !== null);
    return { name: s.name, value: last ? (last[1] as number) : null };
  });

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{panel.title}</h3>
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
          {panel.unit}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-[var(--color-mute)]">{panel.description}</p>

      {showTable ? (
        <MetricTable panel={panel} colorFor={colorFor} />
      ) : (
        <TimeSeriesChart series={panel.series} unit={panel.unit} colorFor={colorFor} />
      )}

      {/* A legend is always present for two or more series, so identity never
          rests on colour alone. A single series is named by the title. */}
      {panel.series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {latest.map((entry) => (
            <span key={entry.name} className="flex items-center gap-1.5 text-[11px]">
              <span className="inline-block h-2 w-2 rounded-sm"
                    style={{ background: colorFor(entry.name) }} />
              <span className="text-[var(--color-mute)]">{entry.name}</span>
              <span className="font-medium text-slate-200">
                {entry.value === null ? "—" : formatValue(entry.value, panel.unit)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The accessible equivalent of the plot: the same numbers, most recent first. */
function MetricTable({ panel, colorFor }: {
  panel: MetricPanel; colorFor: (n: string) => string;
}) {
  const stamps = panel.series[0]?.points.map(([t]) => t) ?? [];
  const rows = stamps.map((_, i) => i).reverse().slice(0, 40);

  if (stamps.length === 0) {
    return <p className="py-6 text-center text-xs text-[var(--color-mute)]">No data.</p>;
  }

  return (
    <div className="max-h-[170px] overflow-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
          <tr>
            <th className="py-1 pr-2 font-semibold">Time</th>
            {panel.series.map((s) => (
              <th key={s.name} className="py-1 pl-2 text-right font-semibold">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm"
                        style={{ background: colorFor(s.name) }} />
                  {s.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((i) => (
            <tr key={stamps[i]}>
              <td className="py-0.5 pr-2 text-[var(--color-mute)]">
                {new Date(stamps[i] * 1000).toLocaleTimeString()}
              </td>
              {panel.series.map((s) => {
                const value = s.points[i]?.[1];
                return (
                  <td key={s.name} className="py-0.5 pl-2 text-right text-slate-200">
                    {value === null || value === undefined
                      ? "—" : formatValue(value, panel.unit)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
