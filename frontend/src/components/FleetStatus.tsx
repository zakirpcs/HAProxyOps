import { Link } from "react-router-dom";
import { useFleet, type RefreshMode } from "../useFleet";
import type { FleetSummary } from "../types";

/**
 * Fleet health, condensed for the app shell.
 *
 * Reads the shared stream, so this costs no extra connection - it is the whole
 * reason the fleet state moved into a provider. Present on every page, so a
 * node going down while you are buried in one node's servers is still visible.
 */
export default function FleetStatus() {
  const { summary, connected, refresh, pending } = useFleet();
  return (
    <FleetStatusView
      summary={summary} connected={connected} refresh={refresh} pending={pending}
    />
  );
}

/**
 * The rendering, split from the context read so every state - healthy, node
 * down, paused with a backlog, disconnected, still loading - can be rendered
 * and checked without standing up a provider and a live stream.
 */
export function FleetStatusView({ summary, connected, refresh, pending }: {
  summary: FleetSummary | null;
  connected: boolean;
  refresh: RefreshMode;
  pending: number;
}) {
  if (!summary) {
    return (
      <span className="hidden text-xs text-[var(--color-mute)] md:inline">Loading fleet…</span>
    );
  }

  const paused = refresh === "paused";
  const problems = summary.nodes_down > 0 || summary.servers_down > 0;
  const allUp = summary.nodes_total > 0 && !problems;

  // The dot tracks the stream, not the fleet: a red fleet you are watching and
  // a fleet you have stopped receiving are different problems, and conflating
  // them hides the second one.
  const streamTone = !connected
    ? "bg-[var(--color-down)]"
    : paused
      ? "bg-[var(--color-drain)]"
      : "bg-[var(--color-up)]";

  return (
    <Link
      to="/"
      title={
        `${summary.nodes_up}/${summary.nodes_total} nodes reachable · ` +
        `${summary.servers_down} of ${summary.servers_total} servers down · ` +
        (!connected ? "stream disconnected" : paused ? "updates paused" : "live")
      }
      className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-2.5 py-1 outline-none transition hover:border-ink-600 hover:bg-ink-800 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {connected && !paused && (
          // A slow pulse reads as "receiving" without becoming a distraction
          // on a screen someone leaves open all day.
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${streamTone}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${streamTone}`} />
      </span>

      <span className="text-xs font-medium tabular-nums text-slate-200">
        {summary.nodes_up}/{summary.nodes_total}
        <span className="ml-1 hidden font-normal text-[var(--color-mute)] sm:inline">nodes</span>
      </span>

      {summary.nodes_down > 0 && (
        <span className="text-xs font-semibold tabular-nums text-[var(--color-down)]">
          {summary.nodes_down} down
        </span>
      )}

      {/* Server-level trouble on otherwise reachable nodes: the common case,
          and invisible from the node count alone. */}
      {summary.servers_down > 0 && (
        <span className="hidden text-xs font-medium tabular-nums text-[var(--color-drain)] md:inline">
          {summary.servers_down} srv down
        </span>
      )}

      {allUp && (
        <span className="hidden text-xs text-[var(--color-up)] md:inline">healthy</span>
      )}

      {paused && (
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-drain)]">
          paused{pending > 0 ? ` · ${pending}` : ""}
        </span>
      )}
      {!connected && (
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-down)]">
          offline
        </span>
      )}
    </Link>
  );
}
