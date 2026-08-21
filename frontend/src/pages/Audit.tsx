import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api";
import { Panel, StatusDot } from "../components/ui";
import type { AuditEntry } from "../types";

/**
 * The append-only record of who changed what.
 *
 * The backend has written this since the first runtime action; until now there
 * was no way to read it short of psql. For a tool that drains and maints
 * production load balancers, "who took web2 out at 3am" is a first-class
 * question, not a debugging aid.
 */
export default function Audit() {
  const [filter, setFilter] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);

  const query = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.audit(500),
    // Append-only and read rarely; refetching on an interval buys nothing.
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list: AuditEntry[] = query.data ?? [];
    if (needle) {
      list = list.filter((e) =>
        [e.username, e.action, e.node_name, e.target, e.detail, e.source_ip]
          .some((v) => (v ?? "").toLowerCase().includes(needle)));
    }
    if (failuresOnly) list = list.filter((e) => !e.success);
    return list;
  }, [query.data, filter, failuresOnly]);

  if (query.isError) {
    // Match on the status code, not the message: the API returns FastAPI's
    // "Forbidden" detail, which says nothing about who may read this.
    const error = query.error;
    const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403);
    return (
      <Panel title="Audit log">
        <p className="text-sm text-[var(--color-down)]">
          {forbidden
            ? "The audit log is visible to administrators only."
            : (error as Error).message}
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <span className="text-xs text-[var(--color-mute)]">
          {query.isLoading ? "loading…"
            : rows.length === (query.data?.length ?? 0)
              ? `${rows.length} entries`
              : `${rows.length} of ${query.data?.length ?? 0} entries`}
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by user, action, node, target…"
          className="w-full flex-1 rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] sm:w-auto sm:min-w-64"
        />
        <button
          type="button"
          onClick={() => setFailuresOnly((v) => !v)}
          aria-pressed={failuresOnly}
          className={`rounded border px-2.5 py-1.5 text-xs transition ${
            failuresOnly
              ? "border-[var(--color-down)] bg-[var(--color-down)]/15 text-[var(--color-down)]"
              : "border-ink-600 bg-ink-800 text-[var(--color-mute)] hover:text-slate-200"
          }`}
        >
          Failures only
        </button>
      </div>

      <Panel title="Recent activity">
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">
            {query.isLoading ? "Loading…"
              : (query.data?.length ?? 0) === 0
                ? "Nothing recorded yet."
                : "Nothing matches the filter."}
          </p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
                <tr>
                  <th className="border-b border-ink-700 px-2 py-2">When</th>
                  <th className="border-b border-ink-700 px-2 py-2">User</th>
                  <th className="border-b border-ink-700 px-2 py-2">Action</th>
                  <th className="border-b border-ink-700 px-2 py-2">Node</th>
                  <th className="border-b border-ink-700 px-2 py-2">Target</th>
                  <th className="hidden border-b border-ink-700 px-2 py-2 lg:table-cell">Detail</th>
                  <th className="hidden border-b border-ink-700 px-2 py-2 sm:table-cell">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {rows.map((e) => (
                  <tr key={e.id} className={e.success ? "" : "bg-[var(--color-down)]/5"}>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[var(--color-mute)]"
                        title={new Date(e.at).toISOString()}>
                      {new Date(e.at).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-slate-200">{e.username}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <StatusDot status={e.success ? "UP" : "DOWN"} size={6} />
                        <span className="font-mono">{e.action}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[var(--color-mute)]">
                      {e.node_name ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[var(--color-mute)]">
                      {e.target ?? "—"}
                    </td>
                    <td className="hidden max-w-md truncate px-2 py-1.5 text-[var(--color-mute)] lg:table-cell"
                        title={e.detail ?? undefined}>
                      {e.detail ?? "—"}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-1.5 font-mono text-[var(--color-mute)] sm:table-cell">
                      {e.source_ip ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-[var(--color-mute)]">
          Append-only, newest first, capped at the 500 most recent entries.
          Older history stays in the database — query it directly if you need it.
          See <Link to="/nodes" className="text-[var(--color-accent)]">Nodes</Link> for
          what these actions changed.
        </p>
      </Panel>
    </div>
  );
}
