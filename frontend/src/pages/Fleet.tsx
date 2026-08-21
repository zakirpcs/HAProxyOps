import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { REFRESH_OPTIONS, useFleet, type RefreshMode } from "../useFleet";
import { StatusDot, humanDuration } from "../components/ui";
import ServiceSummary from "../components/ServiceSummary";
import type { NodeSnapshot } from "../types";

/** One node flattened to scalars, so sorting is a plain comparison. */
interface Row {
  id: number;
  name: string;
  group: string;
  /** Sort rank: problems first. 0 unreachable, 1 degraded, 2 pending, 3 healthy, 4 disabled. */
  health: number;
  state: "down" | "degraded" | "pending" | "ok" | "disabled";
  version: string;
  uptime: number;
  frontends: number;
  backends: number;
  serversUp: number;
  serversTotal: number;
  /** Active servers down: lost capacity, and what drives the degraded state. */
  serversDown: number;
  /** Backup servers down: the fallback is gone, traffic is not affected. */
  backupsDown: number;
  sessions: number;
  rate: number;
  errors: number;
  ageSeconds: number;
  latencyMs: number;
  error: string | null;
}

function toRow(node: NodeSnapshot, now: number): Row {
  const servers = node.backends.flatMap((b) => b.servers);
  const serversTotal = servers.length;
  const serversUp = servers.filter((s) => s.is_up).length;
  // Split, because the two mean different things. An active server down is
  // lost capacity now; a backup down is lost fallback if the actives fail.
  // Lumping them together marks every node with a standby as degraded, and a
  // colour that is always on stops being read.
  const serversDown = servers.filter((s) => !s.is_up && !s.backup).length;
  const backupsDown = servers.filter((s) => !s.is_up && s.backup).length;
  const sessions = node.frontends.reduce((a, f) => a + f.sessions_current, 0);
  const rate = node.frontends.reduce((a, f) => a + f.rate, 0);
  const errors =
    node.frontends.reduce((a, f) => a + f.request_errors, 0) +
    node.backends.reduce((a, b) => a + b.connection_errors + b.response_errors, 0);

  const state: Row["state"] =
    node.enabled === false ? "disabled"
      : node.pending ? "pending"
        : !node.reachable ? "down"
          : serversDown > 0 ? "degraded"
            : "ok";
  const health = { down: 0, degraded: 1, pending: 2, ok: 3, disabled: 4 }[state];

  return {
    id: node.node_id,
    name: node.node_name,
    group: node.group,
    health,
    state,
    version: node.info?.version ?? "",
    uptime: node.info?.uptime_seconds ?? 0,
    frontends: node.frontends.length,
    backends: node.backends.length,
    serversUp,
    serversTotal,
    serversDown,
    backupsDown,
    sessions,
    rate,
    errors,
    ageSeconds: node.polled_at ? Math.max(0, (now - Date.parse(node.polled_at)) / 1000) : 0,
    latencyMs: node.duration_ms ?? 0,
    error: node.error,
  };
}

type SortKey = keyof Pick<Row,
  "name" | "group" | "health" | "version" | "uptime" | "frontends" | "backends" |
  "serversDown" | "serversTotal" | "sessions" | "rate" | "errors" | "ageSeconds" | "latencyMs">;

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
  title?: string;
  /** Hidden below lg, to keep the important columns visible on a laptop. */
  optional?: boolean;
  /** Hidden below sm as well: the first thing to go on a phone. */
  minor?: boolean;
}

const COLUMNS: Column[] = [
  { key: "health", label: "State", title: "Sort problems to the top" },
  { key: "name", label: "Node" },
  { key: "group", label: "Group", optional: true },
  { key: "version", label: "Version", optional: true },
  { key: "uptime", label: "Uptime", numeric: true, optional: true },
  { key: "frontends", label: "FE", numeric: true, title: "Frontends", minor: true },
  { key: "backends", label: "BE", numeric: true, title: "Backends", minor: true },
  { key: "serversTotal", label: "Servers", numeric: true, title: "Servers up / total" },
  { key: "serversDown", label: "Down", numeric: true, title: "Servers not up" },
  { key: "sessions", label: "Sessions", numeric: true, title: "Current sessions" },
  { key: "rate", label: "Rate", numeric: true, title: "Frontend session rate", optional: true },
  { key: "errors", label: "Errors", numeric: true, title: "Request + connection + response errors" },
  { key: "latencyMs", label: "Poll", numeric: true, title: "Last poll duration", optional: true },
  { key: "ageSeconds", label: "Age", numeric: true, title: "Time since last successful poll" },
];

const STATE_LABEL: Record<Row["state"], string> = {
  down: "DOWN", degraded: "DEGRADED", pending: "PENDING", ok: "UP", disabled: "OFF",
};
const STATE_STATUS: Record<Row["state"], string> = {
  down: "DOWN", degraded: "DRAIN", pending: "", ok: "UP", disabled: "MAINT",
};

export default function Fleet() {
  // Refresh mode now lives in the provider: one stream, one cadence, and the
  // app shell can show it.
  const {
    nodes, summary, connected, error, pending, committedAt, refreshNow, refresh, setRefresh,
  } = useFleet();
  const navigate = useNavigate();

  const [filter, setFilter] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [grouped, setGrouped] = useState(false);
  // Node ids, not indexes: rows re-sort on every poll and an index would
  // expand whichever node happened to land in that position.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "health", dir: 1 });

  // Drives the "Age" column. Snapshots arrive on their own schedule, so the
  // clock has to tick independently - slowly, since this re-renders the table.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Rows are flattened to scalars for sorting; the service view needs the
  // whole snapshot back.
  const byId = useMemo(
    () => new Map(nodes.map((n) => [n.node_id, n])),
    [nodes],
  );

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = nodes.map((n) => toRow(n, now));
    if (needle) {
      list = list.filter(
        (r) => r.name.toLowerCase().includes(needle) || r.group.toLowerCase().includes(needle),
      );
    }
    if (problemsOnly) list = list.filter((r) => r.state === "down" || r.state === "degraded");

    const { key, dir } = sort;
    return list.sort((a, b) => {
      const x = a[key];
      const y = b[key];
      const cmp = typeof x === "string" && typeof y === "string"
        ? x.localeCompare(y)
        : Number(x) - Number(y);
      // Ties always fall back to name, so row order never jitters between polls.
      return cmp !== 0 ? cmp * dir : a.name.localeCompare(b.name);
    });
  }, [nodes, filter, problemsOnly, sort, now]);

  const sections = useMemo(() => {
    if (!grouped) return [{ group: null as string | null, rows }];
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const list = map.get(row.group) ?? [];
      list.push(row);
      map.set(row.group, list);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, groupRows]) => ({ group, rows: groupRows }));
  }, [rows, grouped]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        // Numbers are most useful highest-first; names and states ascending.
        : { key, dir: key === "name" || key === "group" || key === "health" ? 1 : -1 },
    );
  }

  // A row is stale when its data is older than the poll cadence by a clear
  // margin. Scaled to the selected refresh so a 60s interval does not paint
  // every row amber for working normally.
  const staleAfter = typeof refresh === "number" ? Math.max(60, (refresh / 1000) * 2) : 60;

  const problemCount = nodes.filter(
    (n) => (n.enabled !== false && !n.reachable && !n.pending) ||
      n.backends.some((b) => b.servers.some((s) => !s.is_up && !s.backup)),
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Fleet</h1>
        <span className="flex items-center gap-2 text-xs text-[var(--color-mute)]">
          <StatusDot
            status={!connected ? "DOWN" : refresh === "paused" ? "MAINT" : "UP"}
            size={7}
          />
          {!connected
            ? "reconnecting…"
            : refresh === "paused"
              ? `paused${pending ? ` · ${pending} update${pending === 1 ? "" : "s"} held` : ""}`
              : refresh === "live"
                ? "live"
                : `every ${(refresh as number) / 1000}s`}
          {committedAt !== null && (
            <span title={new Date(committedAt).toLocaleTimeString()}>
              · updated {Math.max(0, Math.round((now - committedAt) / 1000))}s ago
            </span>
          )}
        </span>
        <span className="ml-auto text-xs text-[var(--color-mute)]">
          {rows.length === nodes.length
            ? `${nodes.length} node${nodes.length === 1 ? "" : "s"}`
            : `${rows.length} of ${nodes.length} nodes`}
        </span>
      </div>

      {error && (
        <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-sm text-[var(--color-down)]">
          {error}
        </p>
      )}

      {summary && (
        // One card, one line. A grid wrapped to a second row as soon as the
        // conditional "Backups down" stat appeared, so the summary changed
        // height depending on fleet health - exactly when it should be a
        // fixed thing you glance at. Scrolls sideways rather than wrapping;
        // the two stats that matter most lead, so they are never scrolled off.
        <div
          role="group"
          aria-label="Fleet summary"
          className="flex items-stretch overflow-x-auto rounded-lg border border-ink-700 bg-ink-900"
        >
          <Stat label="Nodes" value={`${summary.nodes_up}/${summary.nodes_total}`}
                tone={summary.nodes_down > 0 ? "bad" : "good"} />
          <Stat label="Problems" value={problemCount} tone={problemCount ? "bad" : "good"} />
          <Stat label="Srv down" value={summary.servers_down}
                tone={summary.servers_down > 0 ? "bad" : "good"} />
          {summary.backups_down > 0 && (
            <Stat label="Backups" value={summary.backups_down} tone="warn"
                  title="Backup servers down — no fallback if the active servers fail" />
          )}
          <Stat label="Servers" value={summary.servers_total} />
          <Stat label="Frontends" value={summary.frontends} />
          <Stat label="Backends" value={summary.backends} />
          <Stat label="Sessions" value={summary.sessions_current.toLocaleString()} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by node or group…"
          className="w-full flex-1 rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] sm:w-auto sm:min-w-56"
        />
        <Toggle active={problemsOnly} onClick={() => setProblemsOnly((v) => !v)}
                title="Show only unreachable or degraded nodes">
          Problems only{problemCount > 0 && ` (${problemCount})`}
        </Toggle>
        <Toggle active={grouped} onClick={() => setGrouped((v) => !v)}
                title="Break the table into sections by group">
          Group
        </Toggle>

        <label className="flex items-center gap-1.5 text-xs text-[var(--color-mute)]">
          <span className="hidden sm:inline">Refresh</span>
          <select
            value={String(refresh)}
            onChange={(e) => {
              const raw = e.target.value;
              const next: RefreshMode =
                raw === "live" || raw === "paused" ? raw : Number(raw);
              // setRefresh persists it; the provider owns that now.
              setRefresh(next);
            }}
            title="How often the table applies incoming updates. The stream keeps running either way."
            className="rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[var(--color-accent)]"
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={refreshNow}
          title="Refetch now and show the result, whatever the refresh mode"
          className="relative rounded border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs font-medium text-[var(--color-mute)] transition hover:text-slate-200"
        >
          Refresh
          {pending > 0 && (
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-white">
              {pending > 99 ? "99+" : pending}
            </span>
          )}
        </button>
      </div>

      {/* Scrolls in both axes with a capped height, which is what makes the
          sticky header actually stick: a container that only scrolls
          horizontally never triggers sticky positioning. */}
      <div className="max-h-[75vh] overflow-auto rounded-lg border border-ink-700 sm:max-h-[70vh]">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-ink-900 shadow-[0_1px_0_var(--color-ink-700)]">
            <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
              <th className="w-7 border-b border-ink-700 px-1 py-2">
                <span className="sr-only">Expand services</span>
              </th>
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    title={col.title}
                    aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                    className={`border-b border-ink-700 px-2.5 py-2 font-semibold whitespace-nowrap
                      ${col.numeric ? "text-right" : "text-left"}
                      ${col.optional ? "hidden lg:table-cell" : ""}
                      ${col.minor ? "hidden sm:table-cell" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={`inline-flex items-center gap-1 hover:text-slate-200 ${
                        active ? "text-slate-100" : ""}`}
                    >
                      {col.label}
                      <span className={active ? "opacity-100" : "opacity-0"}>
                        {sort.dir === 1 ? "▲" : "▼"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>

          {sections.map(({ group, rows: sectionRows }) => (
            <tbody key={group ?? "__all"}>
              {group !== null && (
                <tr>
                  <td colSpan={COLUMNS.length + 1}
                      className="border-b border-ink-700 bg-ink-800/60 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-slate-300">
                    {group}
                    <span className="ml-2 font-normal text-[var(--color-mute)]">
                      {sectionRows.length}
                    </span>
                  </td>
                </tr>
              )}
              {sectionRows.map((row) => (
                <NodeRow
                  key={row.id} row={row} staleAfter={staleAfter}
                  snapshot={byId.get(row.id)}
                  expanded={expanded.has(row.id)}
                  onToggle={() => setExpanded((prev) => {
                    const next = new Set(prev);
                    next.has(row.id) ? next.delete(row.id) : next.add(row.id);
                    return next;
                  })}
                  onOpen={() => navigate(`/nodes/${row.id}`)}
                />
              ))}
            </tbody>
          ))}
        </table>

        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-[var(--color-mute)]">
            {nodes.length === 0
              ? "No nodes registered yet — add one under Nodes."
              : "No nodes match the current filter."}
          </p>
        )}
      </div>
    </div>
  );
}

function NodeRow({ row, staleAfter, snapshot, expanded, onToggle, onOpen }: {
  row: Row; staleAfter: number;
  snapshot: NodeSnapshot | undefined;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const stale = row.ageSeconds > staleAfter && row.state !== "pending";
  const cell = "px-2.5 py-1.5 whitespace-nowrap";
  const num = `${cell} text-right`;
  const opt = "hidden lg:table-cell";
  const minor = "hidden sm:table-cell";

  return (
    <>
    <tr
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className="cursor-pointer border-b border-ink-800 outline-none transition hover:bg-ink-800/70 focus:bg-ink-800/70"
    >
      <td className="px-1 py-1.5 align-middle">
        <button
          type="button"
          // The row navigates to the node page; expanding must not do both.
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} services on ${row.name}`}
          title={`${expanded ? "Hide" : "Show"} frontends and backends`}
          className="w-5 rounded text-[var(--color-mute)] transition hover:bg-ink-700 hover:text-slate-200"
        >
          {expanded ? "\u25be" : "\u25b8"}
        </button>
      </td>
      <td className={cell}>
        <span className="flex items-center gap-2">
          <StatusDot status={STATE_STATUS[row.state]} size={7} />
          <span className={
            row.state === "down" ? "text-[var(--color-down)]"
              : row.state === "degraded" ? "text-[var(--color-drain)]"
                : row.state === "ok" ? "text-[var(--color-up)]"
                  : "text-[var(--color-mute)]"
          }>
            {STATE_LABEL[row.state]}
          </span>
        </span>
      </td>

      <td className={`${cell} font-medium text-slate-100`}>
        {row.name}
        {row.error && (
          <span className="ml-2 font-normal text-[var(--color-down)]" title={row.error}>
            {row.error.length > 44 ? `${row.error.slice(0, 44)}…` : row.error}
          </span>
        )}
      </td>

      <td className={`${cell} ${opt} text-[var(--color-mute)]`}>{row.group}</td>
      <td className={`${cell} ${opt} font-mono text-[var(--color-mute)]`}>{row.version || "—"}</td>
      <td className={`${num} ${opt} text-[var(--color-mute)]`}>
        {row.uptime ? humanDuration(row.uptime) : "—"}
      </td>

      <td className={`${num} ${minor}`}>{row.frontends || "—"}</td>
      <td className={`${num} ${minor}`}>{row.backends || "—"}</td>
      <td className={num}>
        {row.serversTotal ? (
          <span className={row.serversDown ? "text-[var(--color-drain)]" : ""}>
            {row.serversUp}/{row.serversTotal}
          </span>
        ) : "—"}
      </td>
      <td className={`${num} ${row.serversDown ? "font-semibold text-[var(--color-down)]" : "text-[var(--color-mute)]"}`}>
        {row.serversDown || "—"}
        {row.backupsDown > 0 && (
          // Deliberately quiet: a standby that is down costs no traffic today,
          // but it is the thing you wanted when the actives fail.
          <span
            title={`${row.backupsDown} backup server${row.backupsDown === 1 ? "" : "s"} down — no fallback if the active servers fail`}
            className="ml-1 rounded bg-ink-700 px-1 text-[10px] font-normal text-[var(--color-drain)]"
          >
            {row.backupsDown} bck
          </span>
        )}
      </td>
      <td className={num}>{row.sessions.toLocaleString()}</td>
      <td className={`${num} ${opt} text-[var(--color-mute)]`}>{row.rate.toLocaleString()}</td>
      <td className={`${num} ${row.errors ? "text-[var(--color-down)]" : "text-[var(--color-mute)]"}`}>
        {row.errors.toLocaleString()}
      </td>
      <td className={`${num} ${opt} text-[var(--color-mute)]`}>
        {row.latencyMs ? `${row.latencyMs}ms` : "—"}
      </td>
      <td className={`${num} ${stale ? "text-[var(--color-drain)]" : "text-[var(--color-mute)]"}`}>
        {row.state === "pending" ? "—" : `${Math.round(row.ageSeconds)}s`}
      </td>
    </tr>

    {expanded && (
      <tr className="border-b border-ink-800 bg-ink-900/40">
        <td />
        <td colSpan={COLUMNS.length} className="px-2.5 py-2">
          {snapshot
            ? <ServiceSummary node={snapshot} />
            : <p className="text-[11px] text-[var(--color-mute)]">No snapshot for this node yet.</p>}
        </td>
      </tr>
    )}
    </>
  );
}

/** One cell of the summary strip: label and value on a single baseline. */
function Stat({ label, value, tone = "default", title }: {
  label: string; value: React.ReactNode; title?: string;
  // "warn" is a real third level here: a down backup is not lost capacity, but
  // it is not nothing either.
  tone?: "default" | "good" | "bad" | "warn";
}) {
  const color = tone === "bad" ? "text-[var(--color-down)]"
    : tone === "warn" ? "text-[var(--color-drain)]"
      : tone === "good" ? "text-[var(--color-up)]" : "text-slate-100";
  return (
    <div title={title}
         className="flex shrink-0 items-baseline gap-1.5 border-r border-ink-800 px-3 py-2 last:border-r-0">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-mute)]">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function Toggle({ active, onClick, children, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode; title?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      aria-pressed={active}
      className={`rounded border px-2.5 py-1.5 text-xs font-medium transition ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "border-ink-600 bg-ink-800 text-[var(--color-mute)] hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
