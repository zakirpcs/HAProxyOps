import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFleet } from "../useFleet";
import NodeMetrics from "../components/NodeMetrics";
import { Panel, StatusDot, humanDuration } from "../components/ui";
import type { NodeSnapshot } from "../types";

const STORAGE_KEY = "haproxyops.metricsNode";

/** Node state, reduced to the three words the picker needs to show. */
function stateOf(node: NodeSnapshot): { label: string; status: string } {
  if (node.enabled === false) return { label: "OFF", status: "MAINT" };
  if (node.pending) return { label: "PENDING", status: "" };
  if (!node.reachable) return { label: "DOWN", status: "DOWN" };
  const down = node.backends.some((b) => b.servers.some((s) => !s.is_up && !s.backup));
  return down ? { label: "DEGRADED", status: "DRAIN" } : { label: "UP", status: "UP" };
}

/**
 * Graphs for one node at a time, chosen from a dropdown.
 *
 * Separate from the node page because the two answer different questions: that
 * page is "what is this node doing right now", this one is "how has it behaved
 * over the last few hours", and the second is usually asked while comparing
 * nodes rather than while drilling into one.
 */
export default function Metrics() {
  const { nodes, connected } = useFleet();

  // Remembered across visits: coming back to compare the same node again is
  // the common case, and re-picking it every time is pure friction.
  const [nodeId, setNodeId] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });

  const options = useMemo(
    () => [...nodes].sort((a, b) =>
      a.group.localeCompare(b.group) || a.node_name.localeCompare(b.node_name)),
    [nodes],
  );

  // Fall back to the first node once the fleet arrives, and recover if the
  // remembered node has since been removed.
  const selected = options.find((n) => n.node_id === nodeId) ?? options[0] ?? null;

  useEffect(() => {
    if (selected) localStorage.setItem(STORAGE_KEY, String(selected.node_id));
  }, [selected]);

  if (options.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Metrics</h1>
        <Panel title="Metrics">
          <p className="text-sm text-[var(--color-mute)]">
            No nodes registered yet — add one under{" "}
            <Link to="/nodes" className="text-[var(--color-accent)]">Nodes</Link>.
          </p>
        </Panel>
      </div>
    );
  }

  const state = selected ? stateOf(selected) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Metrics</h1>

        <label className="flex items-center gap-2 text-xs text-[var(--color-mute)]">
          <span className="sr-only sm:not-sr-only">Node</span>
          <select
            value={selected?.node_id ?? ""}
            onChange={(e) => setNodeId(Number(e.target.value))}
            aria-label="Node to chart"
            className="min-w-44 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-[var(--color-accent)]"
          >
            {/* Grouped, because a fleet of any size is read group-first. */}
            {[...new Set(options.map((n) => n.group))].map((group) => (
              <optgroup key={group} label={group}>
                {options.filter((n) => n.group === group).map((node) => (
                  <option key={node.node_id} value={node.node_id}>
                    {node.node_name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {selected && state && (
          <span className="flex items-center gap-2 text-xs text-[var(--color-mute)]">
            <StatusDot status={state.status} size={7} />
            {state.label}
            {selected.info?.version && <span>· {selected.info.version}</span>}
            {selected.info?.uptime_seconds != null && (
              <span>· up {humanDuration(selected.info.uptime_seconds)}</span>
            )}
            {!connected && <span className="text-[var(--color-drain)]">· reconnecting…</span>}
          </span>
        )}

        {selected && (
          <Link
            to={`/nodes/${selected.node_id}`}
            className="ml-auto text-xs text-[var(--color-accent)] hover:underline"
          >
            Open {selected.node_name} →
          </Link>
        )}
      </div>

      {selected && !selected.reachable && (
        // Prometheus keeps its own history, so graphs still render for a node
        // the dashboard cannot currently reach. Say so, or the last datapoint
        // looks like the current state.
        <p className="rounded border border-[var(--color-drain)]/40 bg-[var(--color-drain)]/10 px-3 py-2 text-sm text-[var(--color-drain)]">
          {selected.node_name} is unreachable right now. These graphs come from
          Prometheus, so they show history up to the point it stopped scraping.
        </p>
      )}

      {/* Keyed on the node: switching should refetch, not cross-fade one node's
          series into another's. */}
      {selected && <NodeMetrics key={selected.node_id} nodeId={selected.node_id} />}
    </div>
  );
}
