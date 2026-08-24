import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useFleet } from "../useFleet";
import {
  IconButton, Panel, RoleLabel, StatusDot, humanBytes, humanDuration,
} from "../components/ui";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";
import { groupServices, serviceHealth, type Service } from "../services";
import { applyBulk, assessImpact, keyOf, parseKey, type BulkResult } from "../bulk";
import type {
  AdminState, BackendStat, FrontendStat, NodeSnapshot, ServerStat,
} from "../types";

/** Above this many services the node page switches to problems-first. */
const SERVICE_LIMIT = 12;

interface PendingAction {
  backend: string;
  server: string;
  state: AdminState;
}

/** Auto-revert windows offered when taking a server out of rotation. */
const WINDOWS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: "Until I put it back" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
];

export default function NodeDetail() {
  const { nodeId } = useParams();
  const id = Number(nodeId);
  const { nodes, connected } = useFleet();
  const node = useMemo(() => nodes.find((n) => n.node_id === id), [nodes, id]);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // One dialog for the whole page, not one per row: a <dialog> element per
  // server would be hundreds of them on a busy node.
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Open-ended by default: a timed window is a promise to the operator, and
  // one they did not ask for should never be made on their behalf.
  const [holdMinutes, setHoldMinutes] = useState<number | null>(null);
  // Sections the operator opened or closed by hand, keyed by service name.
  // Anything absent falls back to the computed default, so typing in the
  // filter re-opens matches without wiping deliberate choices.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  // Selected servers, as "backend server" keys so the pair travels together.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState<AdminState | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!node) {
    return <p className="text-sm text-[var(--color-mute)]">Loading node {id}…</p>;
  }

  const canAct = node.capabilities?.includes("set_admin_state");
  const canSetWeight = node.capabilities?.includes("set_weight");
  const needle = filter.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);

  const grouping = groupServices(node);
  // A service stays visible when the filter hits any part of it - its frontend,
  // one of its backends, or a single server inside one. Filtering to a server
  // name should not hide the frontend that reaches it.
  const serviceMatches = (service: Service) =>
    match(service.frontend.name) ||
    service.missing.some(match) ||
    service.backends.some((b) => match(b.name) || b.servers.some((sv) => match(sv.name)));
  // Past this many services the page stops trying to show everything at once.
  // Below it, a node is small enough that the old behaviour - everything laid
  // out and open - is still the fastest thing to read.
  const atScale = grouping.services.length > SERVICE_LIMIT;
  const filtering = needle.length > 0;

  const matching = grouping.services.filter(serviceMatches);
  const problems = matching.filter((s) => serviceHealth(s) !== "ok");
  // Search wins over every default: if you typed a name you want that service,
  // healthy or not. Otherwise a large node opens on its problems, because at
  // 120 services you almost never want all of them - you want the broken ones.
  const listed = filtering || !atScale || showAll ? matching : problems;
  const hiddenHealthy = matching.length - listed.length;

  const visibleOrphans = grouping.orphans.filter(
    (b) => match(b.name) || b.servers.some((sv) => match(sv.name)),
  );

  // Open by default when it needs attention, when you searched for it, or when
  // the node is small enough that collapsing buys nothing. A manual toggle
  // always wins, so a section you closed stays closed.
  const defaultOpen = (service: Service) =>
    serviceHealth(service) !== "ok" || filtering || !atScale;
  const isOpen = (service: Service) => toggled[service.key] ?? defaultOpen(service);

  const selected = [...picked].map(parseKey);

  function togglePick(backend: string, server: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = keyOf(backend, server);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function pickAll(backend: string, servers: string[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const server of servers) {
        const key = keyOf(backend, server);
        on ? next.add(key) : next.delete(key);
      }
      return next;
    });
  }

  async function runBulk(state: AdminState) {
    setBulkBusy(true);
    const results = await applyBulk(selected, (t) =>
      api.setAdminState(id, t.backend, t.server, state));
    setBulkBusy(false);
    setBulkResults(results);
    setBulk(null);

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setPicked(new Set());
      setNotice({ kind: "ok", text: `${results.length} servers set to ${state}.` });
    } else {
      // Keep the failures selected so a retry does not need re-picking.
      setPicked(new Set(failed.map((r) => keyOf(r.target.backend, r.target.server))));
      setNotice({
        kind: "err",
        text: `${results.length - failed.length} of ${results.length} set to ${state}; ${failed.length} failed.`,
      });
    }
  }

  async function applyAction({ backend, server, state }: PendingAction) {
    setActionBusy(true);
    setActionError(null);
    try {
      const timed = state !== "ready" ? holdMinutes : null;
      await api.setAdminState(id, backend, server, state,
                              timed ? { for_minutes: timed } : {});
      setNotice({
        kind: "ok",
        text: holdMinutes && state !== "ready"
          ? `${backend}/${server} set to ${state} - returns to ready in ${
              holdMinutes >= 60 ? `${holdMinutes / 60}h` : `${holdMinutes}m`}.`
          : `${backend}/${server} set to ${state} - applied. State refreshes on next poll.`,
      });
      setPending(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Action failed";
      // Surface inside the dialog when one is open, otherwise as a page notice.
      if (pending) setActionError(message);
      else setNotice({ kind: "err", text: message });
    } finally {
      setActionBusy(false);
    }
  }

  // Unlike admin-state, a weight change is a configuration write, not a
  // runtime one - see the driver. There is nothing to confirm (it does not
  // remove a server from rotation), so it applies straight away like ready
  // does, surfaced as a page notice rather than a dialog.
  async function changeWeight(backend: string, server: string, weight: number) {
    try {
      await api.setWeight(id, backend, server, weight);
      setNotice({
        kind: "ok",
        text: `${backend}/${server} weight set to ${weight} - applied. State refreshes on next poll.`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Weight change failed" });
    }
  }

  return (
    <div className="space-y-5">
      <Header node={node} connected={connected} />

      {notice && (
        <p className={`rounded border px-3 py-2 text-sm ${
          notice.kind === "ok"
            ? "border-[var(--color-up)]/40 bg-[var(--color-up)]/10 text-[var(--color-up)]"
            : "border-[var(--color-down)]/40 bg-[var(--color-down)]/10 text-[var(--color-down)]"
        }`}>{notice.text}</p>
      )}

      <input
        value={filter} onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter frontends, backends and servers…"
        className="w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      {grouping.unavailable ? (
        // No configuration access on this transport, so there is no routing to
        // group by. Say why, and fall back to the flat lists.
        <>
          <Panel title={`Frontends (${node.frontends.length})`}>
            <p className="mb-2 text-xs text-[var(--color-mute)]">
              This node&rsquo;s transport cannot read configuration, so frontends
              cannot be matched to their backends. Register it with the Data Plane
              API driver to group them by service.
            </p>
            <FrontendTable frontends={node.frontends.filter((f) => match(f.name))} />
          </Panel>
          <Panel title={`Backends (${node.backends.length})`}>
            <div className="space-y-2">
              {node.backends
                .filter((b) => match(b.name) || b.servers.some((s) => match(s.name)))
                .map((backend) => (
                  <BackendRow
                    key={backend.name} backend={backend}
                    canAct={!!canAct} onRequest={setPending} onApply={applyAction} match={match}
                    canSetWeight={!!canSetWeight} onWeightChange={changeWeight}
                  />
                ))}
            </div>
          </Panel>
        </>
      ) : (
        <>
          <Panel
            title={
              listed.length === matching.length
                ? `Services (${matching.length})`
                : `Services (${listed.length} of ${matching.length})`
            }
            actions={atScale && !filtering && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-pressed={showAll}
                className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-xs text-[var(--color-mute)] transition hover:text-slate-200"
              >
                {showAll ? "Problems only" : `Show all ${matching.length}`}
              </button>
            )}
          >
            {listed.length === 0 ? (
              <p className="text-sm text-[var(--color-mute)]">
                {node.frontends.length === 0
                  ? "No frontends on this node."
                  : filtering
                    ? "Nothing matches the filter."
                    // Not an empty state: everything is fine, which is worth
                    // saying plainly rather than showing a blank panel.
                    : `All ${matching.length} services healthy.`}
              </p>
            ) : (
              <div className="space-y-3">
                {listed.map((service) => (
                  <ServiceSection
                    key={service.key} service={service} shared={grouping.shared}
                    canAct={!!canAct} onRequest={setPending} onApply={applyAction} match={match}
                    canSetWeight={!!canSetWeight} onWeightChange={changeWeight}
                    isPicked={(b, sv) => picked.has(keyOf(b, sv))}
                    onPick={togglePick}
                    onPickAll={pickAll}
                    open={isOpen(service)}
                    onToggle={() => setToggled((prev) => ({
                      ...prev, [service.key]: !isOpen(service),
                    }))}
                    compact={atScale}
                  />
                ))}
              </div>
            )}
            {hiddenHealthy > 0 && (
              <p className="mt-3 text-xs text-[var(--color-mute)]">
                {hiddenHealthy} healthy service{hiddenHealthy === 1 ? "" : "s"} hidden.
                Search by name, or use <em>Show all</em>.
              </p>
            )}
          </Panel>

          {visibleOrphans.length > 0 && (
            <Panel title={`Unrouted backends (${visibleOrphans.length})`}>
              <p className="mb-2 text-xs text-[var(--color-mute)]">
                No frontend on this node routes to these, as far as the configuration
                shows. That is normal for a backend reached another way, and a red flag
                for one that is simply orphaned.
                {grouping.luaFrontends.length > 0 && (
                  <>
                    {" "}
                    <span className="text-[var(--color-drain)]">
                      {grouping.luaFrontends.join(", ")} run{" "}
                      {grouping.luaFrontends.length === 1 ? "a Lua action" : "Lua actions"},
                      which can select a backend without the configuration saying which —
                      so some of these may be routed after all.
                    </span>
                  </>
                )}
              </p>
              <div className="space-y-2">
                {visibleOrphans.map((backend) => (
                  <BackendRow
                    key={backend.name} backend={backend}
                    canAct={!!canAct} onRequest={setPending} onApply={applyAction} match={match}
                    canSetWeight={!!canSetWeight} onWeightChange={changeWeight}
                  />
                ))}
              </div>
            </Panel>
          )}
        </>
      )}

      {picked.size > 0 && (
        // Sticky: on a node with many backends the selection is made by
        // scrolling, and an action bar you have to scroll back to is one you
        // forget you armed.
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-accent)]/50 bg-ink-800 px-3 py-2 shadow-2xl">
          <span className="text-sm font-medium text-slate-100">
            {picked.size} server{picked.size === 1 ? "" : "s"} selected
          </span>
          <button type="button" onClick={() => setPicked(new Set())}
                  className="text-xs text-[var(--color-mute)] underline hover:text-slate-200">
            Clear
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" disabled={!canAct} onClick={() => setBulk("ready")}
                    className="rounded bg-[var(--color-up)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40">
              Ready
            </button>
            <button type="button" disabled={!canAct} onClick={() => setBulk("drain")}
                    className="rounded bg-[var(--color-drain)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40">
              Drain
            </button>
            <button type="button" disabled={!canAct} onClick={() => setBulk("maint")}
                    className="rounded bg-[var(--color-down)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              Maint
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={bulk !== null}
        title={bulk ? `Set ${picked.size} server${picked.size === 1 ? "" : "s"} to ${bulk}?` : ""}
        confirmLabel={bulk ? `Set ${bulk}` : "Confirm"}
        variant={bulk === "maint" ? "danger" : bulk === "ready" ? "default" : "warn"}
        busy={bulkBusy}
        onConfirm={() => bulk && runBulk(bulk)}
        onClose={() => !bulkBusy && setBulk(null)}
      >
        {bulk && <BulkSummary backends={node.backends} selected={selected} state={bulk} />}
      </ConfirmDialog>

      <Modal
        open={bulkResults !== null && bulkResults.some((r) => !r.ok)}
        onClose={() => setBulkResults(null)}
        title="Some servers did not change"
        description="The rest were applied. Failures stay selected so you can retry them."
        width="34rem"
        footer={
          <button type="button" onClick={() => setBulkResults(null)}
                  className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-slate-200">
            Close
          </button>
        }
      >
        <ul className="space-y-1.5 text-sm">
          {(bulkResults ?? []).filter((r) => !r.ok).map((r) => (
            <li key={keyOf(r.target.backend, r.target.server)}
                className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-slate-200">
                {r.target.backend}/{r.target.server}
              </span>
              <span className="text-xs text-[var(--color-down)]">{r.error}</span>
            </li>
          ))}
        </ul>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `Set ${pending.server} to ${pending.state}?` : ""}
        confirmLabel={pending ? `Set ${pending.state}` : "Confirm"}
        variant={pending?.state === "maint" ? "danger" : "warn"}
        busy={actionBusy}
        error={actionError}
        onConfirm={() => pending && applyAction(pending)}
        onClose={() => {
          if (actionBusy) return;
          setPending(null);
          setActionError(null);
        }}
      >
        {pending && pending.state !== "ready" && (
          <label className="block rounded border border-ink-700 bg-ink-800/60 px-3 py-2">
            <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-mute)]">
              Put it back after
            </span>
            <select
              value={holdMinutes ?? ""}
              onChange={(e) => setHoldMinutes(e.target.value ? Number(e.target.value) : null)}
              aria-label="Return to rotation after"
              className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-[var(--color-accent)]"
            >
              {WINDOWS.map((w) => (
                <option key={String(w.minutes)} value={w.minutes ?? ""}>{w.label}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-[var(--color-mute)]">
              {holdMinutes
                ? "The dashboard returns it to rotation automatically. Health checks still " +
                  "decide whether it takes traffic, and a later manual change cancels this."
                : "Forgetting to restore a drained server is the usual way capacity stays " +
                  "quietly halved. A window removes that risk."}
            </span>
          </label>
        )}

        {pending && (
          <ServerActionSummary
            action={pending}
            backend={node.backends.find((b) => b.name === pending.backend)}
          />
        )}
      </ConfirmDialog>

    </div>
  );
}

function Header({ node, connected }: { node: NodeSnapshot; connected: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Link to="/" className="text-sm text-[var(--color-accent)]">← Fleet</Link>
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <StatusDot status={node.reachable ? "UP" : "DOWN"} size={10} />
        {node.node_name}
      </h1>
      <span className="text-xs text-[var(--color-mute)]">
        {node.info.version ?? "unknown version"} · up {humanDuration(node.info.uptime_seconds)} ·{" "}
        {connected ? "live" : "reconnecting…"}
      </span>
      {!node.reachable && node.error && (
        <span className="w-full text-xs text-[var(--color-down)]">{node.error}</span>
      )}
    </div>
  );
}

/**
 * One frontend and the backends it routes to, rendered as a single unit.
 *
 * The frontend keeps its full stats row - grouping should not cost detail that
 * the flat table used to show.
 */
function ServiceSection({
  service, shared, canAct, onRequest, onApply, match, open, onToggle, compact,
  canSetWeight, onWeightChange, isPicked, onPick, onPickAll,
}: {
  service: Service; shared: Set<string>; canAct: boolean;
  onRequest: (action: PendingAction) => void;
  onApply: (action: PendingAction) => void;
  match: (name: string) => boolean;
  open: boolean;
  onToggle: () => void;
  canSetWeight: boolean;
  onWeightChange: (backend: string, server: string, weight: number) => Promise<void>;
  isPicked: (backend: string, server: string) => boolean;
  onPick: (backend: string, server: string) => void;
  onPickAll: (backend: string, servers: string[], on: boolean) => void;
  /** The node has enough services that healthy ones stay shut by default. */
  compact: boolean;
}) {
  const health = serviceHealth(service);
  const targets = service.backends
    .map((b) => b.name)
    .concat(service.missing)
    .concat(service.dynamic);
  const serversDown = service.backends.reduce(
    (n, b) => n + b.servers.filter((sv) => !sv.is_up && !sv.backup).length, 0);

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900/60">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-700 px-3 py-2">
        <button
          type="button" onClick={onToggle} aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${service.frontend.name}`}
          className="-ml-1 rounded px-1 text-[var(--color-mute)] transition hover:bg-ink-700 hover:text-slate-200"
        >
          {open ? "\u25be" : "\u25b8"}
        </button>
        <StatusDot status={health === "ok" ? "UP" : health === "degraded" ? "DRAIN" : "DOWN"} />
        <RoleLabel>Frontend</RoleLabel>
        <span className="font-mono text-xs font-semibold text-slate-100">
          {service.frontend.name}
        </span>
        {targets.length > 0 ? (
          <>
            <span className="text-[var(--color-mute)]">&rarr;</span>
            <RoleLabel>{targets.length === 1 ? "Backend" : "Backends"}</RoleLabel>
            <span className="font-mono text-[11px] text-slate-300">
              {targets.join(", ")}
            </span>
          </>
        ) : (
          // A frontend with no backend is normal for a stats or metrics
          // listener, so this is a note rather than a warning.
          <span className="text-[11px] text-[var(--color-mute)]">no backend</span>
        )}

        {/* A collapsed section must still carry its own bad news, or closing
            it hides the reason it was worth opening. */}
        <span className="ml-auto flex items-center gap-2 text-[11px]">
          {serversDown > 0 && (
            <span className="text-[var(--color-drain)]">{serversDown} srv down</span>
          )}
          {service.missing.length > 0 && (
            <span className="text-[var(--color-down)]">{service.missing.length} missing</span>
          )}
          <span className="text-[var(--color-mute)]">
            {service.frontend.sessions_current.toLocaleString()} sess
          </span>
        </span>
      </header>

      {open && (
      <>
      <div className="px-3 py-2">
        <RoleLabel block>Frontend</RoleLabel>
        <FrontendTable frontends={[service.frontend]} />
      </div>

      {(service.backends.length > 0 || service.missing.length > 0
        || service.dynamic.length > 0) && (
        <div className="space-y-2 border-t border-ink-700 px-3 py-2">
          <RoleLabel block>
            {service.backends.length + service.missing.length === 1 ? "Backend" : "Backends"}
          </RoleLabel>
          {service.backends.map((backend) => (
            <BackendRow
              key={backend.name} backend={backend} canAct={canAct}
              onRequest={onRequest} onApply={onApply} match={match}
              canSetWeight={canSetWeight} onWeightChange={onWeightChange}
              shared={shared.has(backend.name)}
              // On a large node only the backend that is actually broken pays
              // for its server table up front.
              defaultOpen={!compact || backend.servers_up < backend.servers_total}
              parentMatched={match(service.frontend.name)}
              isPicked={(sv) => isPicked(backend.name, sv)}
              onPick={(sv) => onPick(backend.name, sv)}
              onPickAll={(svs, on) => onPickAll(backend.name, svs, on)}
            />
          ))}
          {service.missing.map((name) => (
            <p key={name}
               className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-1.5 text-xs text-[var(--color-down)]">
              <span className="font-mono">{name}</span> is routed to but reports no
              statistics &mdash; the running config and the loaded config disagree.
            </p>
          ))}

          {/* Not a problem, so it must not look like one: the target is an
              expression evaluated per request, not a backend that vanished. */}
          {service.dynamic.map((expr) => (
            <p key={expr}
               className="rounded border border-ink-700 bg-ink-800/50 px-3 py-1.5 text-xs text-[var(--color-mute)]">
              <span className="font-mono text-slate-300">{expr}</span> selects a backend
              per request, so which one it reaches cannot be shown here.
            </p>
          ))}
        </div>
      )}
      </>
      )}
    </section>
  );
}

/** The frontend stats table, shared by the service view and the flat fallback. */
function FrontendTable({ frontends }: { frontends: FrontendStat[] }) {
  if (frontends.length === 0) {
    return <p className="text-xs text-[var(--color-mute)]">No frontends.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-[var(--color-mute)]">
          <tr>
            <th className="pb-2">Name</th><th className="pb-2">Status</th>
            <th className="pb-2 text-right">Sessions</th><th className="pb-2 text-right">Max</th>
            <th className="pb-2 text-right">Limit</th><th className="pb-2 text-right">Rate</th>
            <th className="pb-2 text-right">In</th><th className="pb-2 text-right">Out</th>
            <th className="pb-2 text-right">Req err</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {frontends.map((f) => (
            <tr key={f.name} className="hover:bg-ink-800/60">
              <td className="py-1.5 font-mono text-xs">{f.name}</td>
              <td><span className="flex items-center gap-2 text-xs"><StatusDot status={f.status} />{f.status}</span></td>
              <td className="text-right">{f.sessions_current.toLocaleString()}</td>
              <td className="text-right text-[var(--color-mute)]">{f.sessions_max.toLocaleString()}</td>
              <td className="text-right text-[var(--color-mute)]">{f.sessions_limit || "-"}</td>
              <td className="text-right">{f.rate}</td>
              <td className="text-right text-[var(--color-mute)]">{humanBytes(f.bytes_in)}</td>
              <td className="text-right text-[var(--color-mute)]">{humanBytes(f.bytes_out)}</td>
              <td className={`text-right ${f.request_errors ? "text-[var(--color-down)]" : "text-[var(--color-mute)]"}`}>
                {f.request_errors}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BackendRow({
  backend, canAct, onRequest, onApply, match, shared = false, defaultOpen = true,
  parentMatched = false, canSetWeight, onWeightChange, isPicked, onPick, onPickAll,
}: {
  backend: BackendStat; canAct: boolean;
  onRequest: (action: PendingAction) => void;
  onApply: (action: PendingAction) => void;
  match: (name: string) => boolean;
  canSetWeight: boolean;
  onWeightChange: (backend: string, server: string, weight: number) => Promise<void>;
  /** Reachable from more than one frontend, so it appears in several sections. */
  shared?: boolean;
  /** Whether the server table starts open. False on nodes with many services. */
  defaultOpen?: boolean;
  /**
   * The filter already matched this backend's service by its frontend name.
   *
   * Without it, filtering on a frontend showed the service and its backend
   * header above an empty table: the filter matched the frontend, and then
   * every server was tested against that same text and dropped.
   */
  parentMatched?: boolean;
  isPicked?: (server: string) => boolean;
  onPick?: (server: string) => void;
  onPickAll?: (servers: string[], on: boolean) => void;
}) {
  // Open by default on an ordinary node: the servers are the reason to be on
  // this page, and clicking through every backend to reach them was friction.
  // A node with many services overrides this - see defaultOpen.
  const [open, setOpen] = useState(defaultOpen);
  // The rows the filter is actually showing - select-all must mean "all of
  // these", not "all of them", or a filtered view hides what gets changed.
  const visible = backend.servers.filter(
    (s) => parentMatched || match(backend.name) || match(s.name));
  const degraded = backend.servers_up < backend.servers_total;

  return (
    <div className="rounded border border-ink-700 bg-ink-800/50">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} servers in ${backend.name}`}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ink-800"
      >
        <span className="text-[var(--color-mute)]">{open ? "▾" : "▸"}</span>
        <StatusDot status={backend.status} />
        <span className="font-mono text-xs">{backend.name}</span>
        {shared && (
          // Without this the same backend under two services reads as a bug.
          <span title="Also reachable from another frontend on this node"
                className="rounded bg-ink-700 px-1 text-[10px] text-[var(--color-mute)]">
            shared
          </span>
        )}
        <span className={`ml-auto text-xs ${degraded ? "text-[var(--color-drain)]" : "text-[var(--color-mute)]"}`}>
          {backend.servers_up}/{backend.servers_total} up
        </span>
        <span className="hidden text-xs text-[var(--color-mute)] sm:inline">
          {backend.sessions_current.toLocaleString()} sess
        </span>
        {backend.queue_current > 0 && (
          <span className="text-xs text-[var(--color-drain)]">queue {backend.queue_current}</span>
        )}
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-ink-700 px-3 py-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-[var(--color-mute)]">
              <tr>
                {onPick && (
                  <th className="pb-2 pr-1">
                    <input
                      type="checkbox" disabled={!canAct}
                      aria-label={`Select every server in ${backend.name}`}
                      checked={visible.length > 0 && visible.every((s) => isPicked?.(s.name))}
                      ref={(el) => {
                        if (el) {
                          // Indeterminate cannot be expressed in JSX; a partial
                          // selection must not read as "none selected".
                          const n = visible.filter((s) => isPicked?.(s.name)).length;
                          el.indeterminate = n > 0 && n < visible.length;
                        }
                      }}
                      onChange={(e) => onPickAll?.(visible.map((s) => s.name), e.target.checked)}
                    />
                  </th>
                )}
                <th className="pb-2">Server</th><th className="pb-2">Address</th>
                <th className="pb-2">Status</th><th className="pb-2">Check</th>
                <th className="pb-2 text-right">Wt</th><th className="pb-2 text-right">Sess</th>
                <th className="pb-2 text-right">Queue</th><th className="pb-2 text-right">Errors</th>
                <th className="pb-2 text-right">Last chg</th><th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {visible.map((server) => (
                <ServerRow
                  key={server.name} server={server}
                  canAct={canAct} onRequest={onRequest} onApply={onApply}
                  canSetWeight={canSetWeight} onWeightChange={onWeightChange}
                  picked={isPicked?.(server.name)}
                  onPick={onPick ? () => onPick(server.name) : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ServerRow({
  server, canAct, onRequest, onApply, canSetWeight, onWeightChange, picked, onPick,
}: {
  server: ServerStat; canAct: boolean;
  onRequest: (action: PendingAction) => void;
  onApply: (action: PendingAction) => void;
  canSetWeight: boolean;
  onWeightChange: (backend: string, server: string, weight: number) => Promise<void>;
  picked?: boolean;
  onPick?: () => void;
}) {
  const errors = server.connection_errors + server.response_errors;
  // Editing state lives here, not lifted up: only one row is ever being
  // edited, and lifting it would re-render every row in the backend on each
  // keystroke.
  const [editingWeight, setEditingWeight] = useState<string | null>(null);
  const [weightBusy, setWeightBusy] = useState(false);

  async function saveWeight() {
    if (editingWeight === null) return;
    const value = Number(editingWeight);
    const unchanged = !Number.isInteger(value) || value < 0 || value > 256
      || value === (server.weight ?? 0);
    if (unchanged) {
      setEditingWeight(null);
      return;
    }
    setWeightBusy(true);
    try {
      await onWeightChange(server.backend, server.name, value);
    } finally {
      setWeightBusy(false);
      setEditingWeight(null);
    }
  }

  function changeState(state: AdminState) {
    // Returning a server to rotation is the restorative direction, so it
    // applies immediately. Removing one from rotation asks first.
    if (state === "ready") {
      onApply({ backend: server.backend, server: server.name, state });
      return;
    }
    onRequest({ backend: server.backend, server: server.name, state });
  }

  return (
    <tr className="hover:bg-ink-800/60">
      {onPick && (
        <td className="py-1.5 pr-1">
          <input
            type="checkbox" checked={!!picked} onChange={onPick} disabled={!canAct}
            aria-label={`Select ${server.backend}/${server.name}`}
          />
        </td>
      )}
      <td className="py-1.5 font-mono text-xs">
        {server.name}
        {server.backup && <span className="ml-1.5 rounded bg-ink-700 px-1 text-[10px]">bck</span>}
      </td>
      <td className="font-mono text-xs text-[var(--color-mute)]">{server.address ?? "-"}</td>
      <td><span className="flex items-center gap-2 text-xs"><StatusDot status={server.status} />{server.status}</span></td>
      <td className="text-xs text-[var(--color-mute)]">
        {server.check_status ?? "-"}
        {server.check_failures > 0 && (
          <span className="ml-1 text-[var(--color-drain)]">({server.check_failures})</span>
        )}
      </td>
      <td className="text-right">
        {!canSetWeight ? (
          server.weight ?? "-"
        ) : editingWeight !== null ? (
          <input
            type="number" min={0} max={256} autoFocus
            value={editingWeight}
            disabled={weightBusy}
            aria-label={`Weight for ${server.backend}/${server.name}`}
            onChange={(e) => setEditingWeight(e.target.value)}
            onBlur={saveWeight}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditingWeight(null);
            }}
            className="w-14 rounded border border-ink-600 bg-ink-800 px-1 py-0.5 text-right text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingWeight(String(server.weight ?? 0))}
            title="Click to change weight"
            className="rounded px-1 hover:bg-ink-700 hover:text-slate-200"
          >
            {server.weight ?? "-"}
          </button>
        )}
      </td>
      <td className="text-right">{server.sessions_current.toLocaleString()}</td>
      <td className={`text-right ${server.queue_current ? "text-[var(--color-drain)]" : "text-[var(--color-mute)]"}`}>
        {server.queue_current}
      </td>
      <td className={`text-right ${errors ? "text-[var(--color-down)]" : "text-[var(--color-mute)]"}`}>
        {errors}
      </td>
      <td className="text-right text-xs text-[var(--color-mute)]">
        {humanDuration(server.last_change_seconds)}
      </td>
      <td className="py-1.5">
        <div className="flex justify-end gap-0.5">
          <IconButton
            icon="play" variant="good" disabled={!canAct || server.status === "UP"}
            label={!canAct ? "Ready - this node is read-only"
              : server.status === "UP" ? "Ready - already in rotation"
                : "Ready - return to rotation"}
            onClick={() => changeState("ready")}
          />
          <IconButton
            icon="drain" variant="warn" disabled={!canAct}
            label={canAct
              ? "Drain - finish existing sessions, accept no new ones"
              : "Drain - this node is read-only"}
            onClick={() => changeState("drain")}
          />
          <IconButton
            icon="wrench" variant="danger" disabled={!canAct}
            label={canAct
              ? "Maint - remove from rotation immediately"
              : "Maint - this node is read-only"}
            onClick={() => changeState("maint")}
          />
        </div>
      </td>
    </tr>
  );
}

/**
 * What the action will actually do to the backend.
 *
 * The point of replacing the native confirm() was to answer the question it
 * could not: whether this server is the one holding the backend up. Taking out
 * the last available server stops the backend serving entirely, and that is
 * worth knowing before clicking, not after.
 */
/**
 * What a bulk change does, backend by backend.
 *
 * Selecting one server at a time makes "this is the last one up" obvious.
 * Selecting twelve hides it completely, so the dialog has to say it plainly.
 */
function BulkSummary({ backends, selected, state }: {
  backends: BackendStat[];
  selected: { backend: string; server: string }[];
  state: AdminState;
}) {
  const impact = assessImpact(backends, selected, state);

  return (
    <div className="space-y-3">
      {impact.emptied.length > 0 && (
        <p className="rounded border border-[var(--color-down)] bg-[var(--color-down)]/15 px-3 py-2 text-sm font-medium text-[var(--color-down)]">
          This takes every active server out of{" "}
          <span className="font-mono">{impact.emptied.join(", ")}</span>. Traffic to{" "}
          {impact.emptied.length === 1 ? "that backend" : "those backends"} will fail.
        </p>
      )}

      <table className="w-full text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
          <tr>
            <th className="pb-1">Backend</th>
            <th className="pb-1 text-right">Selected</th>
            <th className="pb-1 text-right">Active up</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {impact.perBackend.map((b) => (
            <tr key={b.backend}>
              <td className="py-1 font-mono text-slate-200">{b.backend}</td>
              <td className="py-1 text-right text-[var(--color-mute)]">
                {b.selected} of {b.total}
              </td>
              <td className={`py-1 text-right font-medium ${
                b.upAfter === 0 ? "text-[var(--color-down)]"
                  : b.upAfter < b.upBefore ? "text-[var(--color-drain)]"
                    : "text-[var(--color-up)]"
              }`}>
                {b.upBefore} &rarr; {b.upAfter}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-[var(--color-mute)]">
        Applied a few at a time rather than all at once, so a large selection does
        not flood the node&rsquo;s management API. Backup servers are not counted as
        capacity.
      </p>
    </div>
  );
}

function ServerActionSummary({ action, backend }: {
  action: PendingAction; backend?: BackendStat;
}) {
  const target = backend?.servers.find((s) => s.name === action.server);
  const activeUp = backend?.servers.filter((s) => s.is_up && !s.backup).length ?? 0;
  const backupUp = backend?.servers.filter((s) => s.is_up && s.backup).length ?? 0;

  // Only meaningful if the server is currently carrying traffic.
  const removesLastActive = !!target?.is_up && !target.backup && activeUp <= 1;

  return (
    <>
      <p>
        <span className="font-mono text-slate-100">{action.backend}/{action.server}</span>
        {action.state === "drain" ? (
          <> stops accepting new sessions. Existing sessions finish normally, which
          is the safe way to take a server out before maintenance.</>
        ) : (
          <> is removed from rotation immediately. Sessions on it are dropped rather
          than allowed to finish.</>
        )}
      </p>

      {backend && (
        <p className="text-[var(--color-mute)]">
          {backend.name} currently has {backend.servers_up} of {backend.servers_total}{" "}
          servers up.
        </p>
      )}

      {removesLastActive && (
        <p className={`rounded border px-3 py-2 text-xs ${
          backupUp > 0
            ? "border-[var(--color-drain)]/40 bg-[var(--color-drain)]/10 text-[var(--color-drain)]"
            : "border-[var(--color-down)]/40 bg-[var(--color-down)]/10 text-[var(--color-down)]"
        }`}>
          {backupUp > 0
            ? `This is the last active server in ${action.backend}. Traffic will fail over to ${backupUp} backup server${backupUp === 1 ? "" : "s"}.`
            : `This is the last available server in ${action.backend}. The backend will have nothing left to route to and will stop serving traffic.`}
        </p>
      )}
    </>
  );
}
