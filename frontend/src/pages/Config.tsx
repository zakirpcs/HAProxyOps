import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFleet } from "../useFleet";
import { Panel } from "../components/ui";
import ConfigEditor from "../components/ConfigEditor";
import {
  describe as describeConfig, diffConfigs,
  type FieldDiff, type NodeConfig, type ProxyDiff,
} from "../configdiff";

const SELECT =
  "rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-[var(--color-accent)]";

/**
 * Declared configuration for one node, or the difference between two.
 *
 * Read-only. The question it answers is "why does lb-edge-2 behave differently
 * from lb-edge-1", which is otherwise unanswerable from the dashboard: the
 * fleet view shows what each node is *doing*, never what it was *told*.
 */
export default function Config() {
  const { nodes } = useFleet();
  const options = useMemo(
    () => [...nodes].sort((a, b) =>
      a.group.localeCompare(b.group) || a.node_name.localeCompare(b.node_name)),
    [nodes],
  );

  const [leftId, setLeftId] = useState<number | null>(null);
  const [rightId, setRightId] = useState<number | null>(null);
  // Editing is per node, so it is offered only when one is in view. Comparing
  // two and editing one at the same time is a good way to edit the wrong one.
  const [editing, setEditing] = useState(false);

  const left = options.find((n) => n.node_id === leftId) ?? options[0] ?? null;
  const right = rightId === null ? null : options.find((n) => n.node_id === rightId) ?? null;

  const leftCfg = useQuery({
    queryKey: ["config", left?.node_id],
    queryFn: () => api.nodeConfig(left!.node_id),
    enabled: !!left,
    // Configuration changes on deploys, not between polls.
    staleTime: 60_000,
    retry: false,
  });
  const rightCfg = useQuery({
    queryKey: ["config", right?.node_id],
    queryFn: () => api.nodeConfig(right!.node_id),
    enabled: !!right,
    staleTime: 60_000,
    retry: false,
  });

  if (options.length === 0) {
    return (
      <Panel title="Configuration">
        <p className="text-sm text-[var(--color-mute)]">
          No nodes registered yet — add one under{" "}
          <Link to="/nodes" className="text-[var(--color-accent)]">Nodes</Link>.
        </p>
      </Panel>
    );
  }

  const diff = leftCfg.data && rightCfg.data
    ? diffConfigs(leftCfg.data, rightCfg.data)
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Configuration</h1>

        <label className="flex items-center gap-1.5 text-xs text-[var(--color-mute)]">
          <span className="sr-only sm:not-sr-only">Node</span>
          <select className={SELECT} aria-label="Node to show"
                  value={left?.node_id ?? ""}
                  onChange={(e) => setLeftId(Number(e.target.value))}>
            {options.map((n) => (
              <option key={n.node_id} value={n.node_id}>{n.node_name}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-[var(--color-mute)]">
          <span>compare with</span>
          <select className={SELECT} aria-label="Node to compare against"
                  value={rightId ?? ""}
                  onChange={(e) => setRightId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">nothing</option>
            {options.filter((n) => n.node_id !== left?.node_id).map((n) => (
              <option key={n.node_id} value={n.node_id}>{n.node_name}</option>
            ))}
          </select>
        </label>

        {!right && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={`rounded border px-2.5 py-1 text-xs transition ${
              editing
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "border-ink-600 bg-ink-800 text-[var(--color-mute)] hover:text-slate-200"
            }`}
          >
            {editing ? "Stop editing" : "Edit"}
          </button>
        )}

        {diff && (
          <span className={`text-xs font-medium ${
            diff.changed === 0 ? "text-[var(--color-up)]" : "text-[var(--color-drain)]"
          }`}>
            {diff.changed === 0
              ? "identical"
              : `${diff.changed} ${diff.changed === 1 ? "difference" : "differences"}`}
          </span>
        )}
      </div>

      {[leftCfg, rightCfg].map((q, i) => q.isError && (
        <p key={i} className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-1.5 text-xs text-[var(--color-down)]">
          {(q.error as Error).message.includes("501")
            ? "This node's transport cannot read configuration. Register it with the Data Plane API driver to compare it."
            : (q.error as Error).message}
        </p>
      ))}

      {editing && !right && left && (
        <ConfigEditor nodeId={left.node_id} nodeName={left.node_name} />
      )}

      {diff ? (
        <>
          <DiffPanel title="Frontends" rows={diff.frontends}
                     a={left!.node_name} b={right!.node_name} />
          <DiffPanel title="Backends" rows={diff.backends}
                     a={left!.node_name} b={right!.node_name} />
        </>
      ) : (
        <SingleView data={leftCfg.data} loading={leftCfg.isLoading} />
      )}
    </div>
  );
}

function DiffPanel({ title, rows, a, b }: {
  title: string; rows: ProxyDiff[]; a: string; b: string;
}) {
  // Differences first: identical proxies are the ones you did not come here for.
  const order = { "only-a": 0, "only-b": 1, differs: 2, same: 3 } as const;
  const sorted = [...rows].sort((x, y) => order[x.status] - order[y.status]);
  const same = rows.filter((r) => r.status === "same").length;

  return (
    <Panel title={`${title} (${rows.length})`}>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-mute)]">Neither node declares any.</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.filter((r) => r.status !== "same").map((row) => (
            <ProxyRow key={row.name} row={row} a={a} b={b} />
          ))}
          {same > 0 && (
            <p className="pt-1 text-[11px] text-[var(--color-mute)]">
              {same} identical on both nodes:{" "}
              <span className="font-mono">
                {rows.filter((r) => r.status === "same").map((r) => r.name).join(", ")}
              </span>
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function ProxyRow({ row, a, b }: { row: ProxyDiff; a: string; b: string }) {
  const onlyOne = row.status === "only-a" || row.status === "only-b";
  const missingFrom = row.status === "only-a" ? b : a;

  return (
    <div className={`rounded border px-2 py-1.5 ${
      onlyOne
        ? "border-[var(--color-down)]/40 bg-[var(--color-down)]/5"
        : "border-[var(--color-drain)]/40 bg-[var(--color-drain)]/5"
    }`}>
      <div className="flex flex-wrap items-center gap-x-2 text-xs">
        <span className="font-mono font-semibold text-slate-100">{row.name}</span>
        {onlyOne ? (
          <span className="text-[var(--color-down)]">
            not declared on {missingFrom}
          </span>
        ) : (
          <span className="text-[var(--color-mute)]">
            {row.fields.length} {row.fields.length === 1 ? "setting" : "settings"} differ
          </span>
        )}
      </div>

      {row.fields.length > 0 && (
        <table className="mt-1 w-full text-[11px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
            <tr>
              <th className="pr-3 font-semibold">Setting</th>
              <th className="pr-3 font-semibold">{a}</th>
              <th className="font-semibold">{b}</th>
            </tr>
          </thead>
          <tbody>
            {row.fields.map((f) => <FieldRow key={f.path} field={f} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FieldRow({ field }: { field: FieldDiff }) {
  // An absent setting is not an empty one; saying so avoids reading a blank
  // cell as "set to nothing".
  const cell = (v: string | null) =>
    v === null
      ? <span className="text-[var(--color-mute)] italic">not set</span>
      : <span className="text-slate-200">{v}</span>;

  return (
    <tr>
      <td className="pr-3 font-mono text-[var(--color-mute)]">{field.path}</td>
      <td className="pr-3 font-mono">{cell(field.a)}</td>
      <td className="font-mono">{cell(field.b)}</td>
    </tr>
  );
}

function SingleView({ data, loading }: {
  data: NodeConfig | undefined; loading: boolean;
}) {
  if (loading) {
    return <Panel title="Configuration"><p className="text-sm text-[var(--color-mute)]">Loading…</p></Panel>;
  }
  if (!data) return null;
  const described = describeConfig(data);

  return (
    <>
      {(["frontends", "backends"] as const).map((kind) => (
        <Panel key={kind}
               title={`${kind === "frontends" ? "Frontends" : "Backends"} (${described[kind].length})`}>
          {described[kind].length === 0 ? (
            <p className="text-sm text-[var(--color-mute)]">None declared.</p>
          ) : (
            <div className="space-y-1.5">
              {described[kind].map((proxy) => (
                <div key={proxy.name} className="rounded border border-ink-800 bg-ink-900/50 px-2 py-1.5">
                  <span className="font-mono text-xs font-semibold text-slate-100">
                    {proxy.name}
                  </span>
                  {proxy.fields.length === 0 ? (
                    <span className="ml-2 text-[11px] text-[var(--color-mute)]">
                      no settings beyond its defaults
                    </span>
                  ) : (
                    <table className="mt-1 w-full text-[11px]">
                      <tbody>
                        {proxy.fields.map((f) => (
                          <tr key={f.path}>
                            <td className="w-1/3 pr-3 font-mono text-[var(--color-mute)]">{f.path}</td>
                            <td className="font-mono text-slate-200">{f.a}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      ))}
    </>
  );
}
