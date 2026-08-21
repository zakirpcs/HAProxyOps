import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { api, openSnapshotStream } from "./api";
import type { FleetSummary, NodeSnapshot } from "./types";

/**
 * How often the view commits incoming snapshots.
 *
 * "live" applies each snapshot the moment it arrives. A number buffers them and
 * commits on that cadence, which keeps rows from re-sorting under the cursor.
 * "paused" freezes the table; the stream stays connected and keeps collecting,
 * so resuming shows current state rather than replaying a backlog.
 */
export type RefreshMode = "live" | "paused" | number;

export const REFRESH_OPTIONS: { value: RefreshMode; label: string }[] = [
  { value: "live", label: "Live" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
  { value: 30000, label: "30s" },
  { value: 60000, label: "60s" },
  { value: "paused", label: "Paused" },
];

const STORAGE_KEY = "haproxyops.refresh";

export function loadRefreshMode(): RefreshMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "live" || raw === "paused") return raw;
  const ms = Number(raw);
  return REFRESH_OPTIONS.some((o) => o.value === ms) ? ms : "live";
}

export function saveRefreshMode(mode: RefreshMode): void {
  localStorage.setItem(STORAGE_KEY, String(mode));
}

interface FleetState {
  nodes: NodeSnapshot[];
  summary: FleetSummary | null;
  connected: boolean;
  error: string | null;
  /** Snapshots received but not yet shown, because of the refresh mode. */
  pending: number;
  /** Epoch ms of the last commit to the visible table. */
  committedAt: number | null;
  refreshNow: () => Promise<void>;
  refresh: RefreshMode;
  setRefresh: (mode: RefreshMode) => void;
}

const FleetContext = createContext<FleetState | null>(null);

/**
 * Fleet state: one REST call for the initial picture, then SSE deltas.
 *
 * A provider rather than a plain hook because every call to the old hook opened
 * its own EventSource. With a status indicator in the app shell alongside a
 * page, that was two streams per browser tab - a real cost server-side once a
 * fleet has an audience. One provider means one stream however many components
 * read from it.
 *
 * Snapshots land in a ref rather than state so that buffering costs no renders
 * while paused - a hundred nodes reporting every few seconds would otherwise
 * re-render the table continuously for no visible benefit.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const incoming = useRef<Map<number, NodeSnapshot>>(new Map());
  const [visible, setVisible] = useState<Map<number, NodeSnapshot>>(new Map());
  const [pending, setPending] = useState(0);
  const [committedAt, setCommittedAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // One shared cadence for the whole app now that there is one shared stream.
  // The shell surfaces it, so a paused node page is explained rather than
  // looking like stale data.
  const [refresh, setRefreshState] = useState<RefreshMode>(loadRefreshMode);

  const setRefresh = useCallback((next: RefreshMode) => {
    setRefreshState(next);
    saveRefreshMode(next);
  }, []);

  // Read inside the SSE handler without re-subscribing when the mode changes:
  // tearing down the EventSource on every dropdown change would drop updates.
  const mode = useRef<RefreshMode>(refresh);
  mode.current = refresh;

  const commit = useCallback(() => {
    setVisible(new Map(incoming.current));
    setPending(0);
    setCommittedAt(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;

    api.fleet()
      .then((data) => {
        if (cancelled) return;
        incoming.current = new Map(data.nodes.map((n) => [n.node_id, n]));
        setVisible(new Map(incoming.current));
        setCommittedAt(Date.now());
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    const source = openSnapshotStream((snapshot) => {
      incoming.current.set(snapshot.node_id, snapshot);
      if (mode.current === "live") {
        setVisible(new Map(incoming.current));
        setCommittedAt(Date.now());
      } else {
        setPending((p) => p + 1);
      }
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  // Commit on a timer when a fixed interval is selected.
  useEffect(() => {
    if (typeof refresh !== "number") return;
    const timer = setInterval(commit, refresh);
    return () => clearInterval(timer);
  }, [refresh, commit]);

  // Changing the mode shows current state at once rather than waiting out the
  // next tick - going from 60s to 10s should feel immediate. Pausing is the
  // one case that must not commit, since freezing the table is the point.
  useEffect(() => {
    if (refresh !== "paused") commit();
  }, [refresh, commit]);

  /** Force a hard resync: refetch over REST, then show it. */
  const refreshNow = useCallback(async () => {
    try {
      const data = await api.fleet();
      incoming.current = new Map(data.nodes.map((n) => [n.node_id, n]));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      commit();
    }
  }, [commit]);

  const value = useMemo<FleetState>(() => {
    const list = [...visible.values()].sort(
      (a, b) => a.group.localeCompare(b.group) || a.node_name.localeCompare(b.node_name),
    );

    const summary: FleetSummary = {
      nodes_total: list.length,
      nodes_up: list.filter((n) => n.reachable).length,
      nodes_down: list.filter((n) => n.enabled !== false && !n.reachable).length,
      frontends: list.reduce((acc, n) => acc + n.frontends.length, 0),
      backends: list.reduce((acc, n) => acc + n.backends.length, 0),
      servers_total: list.reduce(
        (a, n) => a + n.backends.reduce((b, k) => b + k.servers.length, 0), 0),
      // Active only: a backup is supposed to be down while the primaries are
      // healthy, so counting it would paint a working fleet as broken.
      servers_down: list.reduce((a, n) => a + n.backends.reduce(
        (b, k) => b + k.servers.filter((s) => !s.is_up && !s.backup).length, 0), 0),
      backups_down: list.reduce((a, n) => a + n.backends.reduce(
        (b, k) => b + k.servers.filter((s) => !s.is_up && s.backup).length, 0), 0),
      sessions_current: list.reduce(
        (a, n) => a + n.frontends.reduce((b, f) => b + f.sessions_current, 0), 0),
    };

    return {
      nodes: list,
      summary: loading ? null : summary,
      connected, error, pending, committedAt, refreshNow, refresh, setRefresh,
    };
  }, [visible, loading, connected, error, pending, committedAt, refreshNow, refresh, setRefresh]);

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): FleetState {
  const ctx = useContext(FleetContext);
  if (!ctx) {
    // Loud on purpose: the failure mode otherwise is an empty fleet that looks
    // like a backend problem rather than a missing provider.
    throw new Error("useFleet must be used inside <FleetProvider>");
  }
  return ctx;
}
