import { groupServices, serviceHealth } from "../services";
import type { BackendStat, NodeSnapshot, ServerStat } from "../types";
import { RoleLabel, StatusDot } from "./ui";

/**
 * The service grouping condensed for a fleet table row: each frontend, the
 * backends it routes to, and the servers inside them.
 *
 * The node page shows the same grouping with full statistics and the runtime
 * actions. This stays read-only by design - acting on a server is a decision
 * that belongs next to the detail justifying it, not in a dense table being
 * scanned across dozens of nodes.
 */
export default function ServiceSummary({ node }: { node: NodeSnapshot }) {
  const { services, orphans, shared, unavailable } = groupServices(node);

  if (unavailable) {
    return (
      <p className="text-[11px] text-[var(--color-mute)]">
        This node&rsquo;s transport cannot read configuration, so its frontends
        cannot be matched to backends.
      </p>
    );
  }
  if (services.length === 0 && orphans.length === 0) {
    return <p className="text-[11px] text-[var(--color-mute)]">No frontends or backends.</p>;
  }

  // A shared backend appears under every frontend that reaches it. Repeating
  // its summary line is useful - repeating its whole server table is not, and
  // an edge node terminating :80 and :443 into one 20-server pool would render
  // that table twice. Show the servers the first time and point at them after.
  const serversShownUnder = new Map<string, string>();
  for (const service of services) {
    for (const backend of service.backends) {
      if (!serversShownUnder.has(backend.name)) {
        serversShownUnder.set(backend.name, service.frontend.name);
      }
    }
  }

  return (
    <div className="space-y-1.5">
      {services.map((service) => {
        const health = serviceHealth(service);
        const targets = service.backends.length + service.missing.length;
        return (
          <div key={service.key} className="rounded border border-ink-800 bg-ink-900/50 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <StatusDot
                status={health === "ok" ? "UP" : health === "degraded" ? "DRAIN" : "DOWN"}
                size={6}
              />
              <RoleLabel>Frontend</RoleLabel>
              <span className="font-mono text-[11px] text-slate-200">{service.frontend.name}</span>
              <span className="text-[10px] text-[var(--color-mute)]">
                {service.frontend.status}
              </span>
              <span className="text-[10px] text-[var(--color-mute)]">
                {service.frontend.sessions_current.toLocaleString()} sess
              </span>
              {service.frontend.rate > 0 && (
                <span className="text-[10px] text-[var(--color-mute)]">
                  {service.frontend.rate}/s
                </span>
              )}
              {service.frontend.request_errors > 0 && (
                <span className="text-[10px] text-[var(--color-down)]">
                  {service.frontend.request_errors} req err
                </span>
              )}
              {targets === 0 && (
                <span className="text-[10px] text-[var(--color-mute)]">· no backend</span>
              )}
            </div>

            {service.backends.map((backend) => (
              <BackendBlock
                key={backend.name} backend={backend} shared={shared.has(backend.name)}
                shownUnder={
                  serversShownUnder.get(backend.name) === service.frontend.name
                    ? null
                    : serversShownUnder.get(backend.name) ?? null
                }
              />
            ))}

            {service.missing.map((name) => (
              <p key={name} className="mt-1 ml-2 border-l border-[var(--color-down)]/40 pl-2 text-[10px] text-[var(--color-down)]">
                <span className="font-mono">{name}</span> is routed to but reports no statistics.
              </p>
            ))}
          </div>
        );
      })}

      {orphans.length > 0 && (
        <div className="rounded border border-ink-800 bg-ink-900/50 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <RoleLabel>Unrouted</RoleLabel>
            <span className="text-[10px] text-[var(--color-mute)]">
              no frontend on this node routes here
            </span>
          </div>
          {orphans.map((backend) => (
            <BackendBlock key={backend.name} backend={backend} shared={false} shownUnder={null} />
          ))}
        </div>
      )}
    </div>
  );
}

function BackendBlock({ backend, shared, shownUnder }: {
  backend: BackendStat; shared: boolean;
  /** Frontend whose section already lists this backend's servers, if any. */
  shownUnder: string | null;
}) {
  const degraded = backend.servers_up < backend.servers_total;

  return (
    <div className="mt-1 ml-2 border-l border-ink-700 pl-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[var(--color-mute)]">&rarr;</span>
        <RoleLabel>Backend</RoleLabel>
        <StatusDot status={backend.status} size={6} />
        <span className="font-mono text-[11px] text-slate-300">{backend.name}</span>
        <span className={`text-[10px] ${
          degraded ? "text-[var(--color-drain)]" : "text-[var(--color-mute)]"
        }`}>
          {backend.servers_up}/{backend.servers_total} up
        </span>
        {shared && (
          // Without this the same backend under two services reads as a bug.
          <span title="Also reachable from another frontend on this node"
                className="rounded bg-ink-700 px-1 text-[9px] text-[var(--color-mute)]">
            shared
          </span>
        )}
        <span className="text-[10px] text-[var(--color-mute)]">
          {backend.sessions_current.toLocaleString()} sess
        </span>
        {backend.queue_current > 0 && (
          <span className="text-[10px] text-[var(--color-drain)]">
            queue {backend.queue_current}
          </span>
        )}
      </div>
      {shownUnder === null ? (
        <ServerTable servers={backend.servers} />
      ) : (
        <p className="mt-0.5 text-[10px] text-[var(--color-mute)]">
          Same backend &mdash; servers listed under{" "}
          <span className="font-mono text-slate-400">{shownUnder}</span> above.
        </p>
      )}
    </div>
  );
}

function ServerTable({ servers }: { servers: ServerStat[] }) {
  if (servers.length === 0) {
    return (
      <p className="mt-0.5 text-[10px] text-[var(--color-mute)]">No servers in this backend.</p>
    );
  }
  // Down servers first: on a degraded backend the failing member is the reason
  // the row was expanded at all. Ties keep config order.
  const ordered = [...servers].sort((a, b) => Number(a.is_up) - Number(b.is_up));

  return (
    <div className="mt-0.5 overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead className="text-left uppercase tracking-wider text-[var(--color-mute)]">
          <tr>
            <th className="py-0.5 pr-2 font-semibold">Server</th>
            <th className="py-0.5 pr-2 font-semibold">Address</th>
            <th className="py-0.5 pr-2 font-semibold">Status</th>
            <th className="py-0.5 pr-2 font-semibold">Check</th>
            <th className="py-0.5 pr-2 text-right font-semibold">Wt</th>
            <th className="py-0.5 pr-2 text-right font-semibold">Sess</th>
            <th className="py-0.5 pr-2 text-right font-semibold">Queue</th>
            <th className="py-0.5 text-right font-semibold">Err</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((server) => {
            const errors = server.connection_errors + server.response_errors;
            return (
              <tr key={server.name}>
                <td className="py-0.5 pr-2 font-mono text-slate-300">
                  {server.name}
                  {server.backup && (
                    <span title="Backup server: takes traffic only when the active ones are down"
                          className="ml-1 rounded bg-ink-700 px-1 text-[9px] text-[var(--color-mute)]">
                      bck
                    </span>
                  )}
                </td>
                <td className="py-0.5 pr-2 font-mono text-[var(--color-mute)]">
                  {server.address ?? "—"}
                </td>
                <td className="py-0.5 pr-2">
                  <span className="flex items-center gap-1">
                    <StatusDot status={server.status} size={5} />
                    <span className={server.is_up ? "text-[var(--color-mute)]" : "text-[var(--color-down)]"}>
                      {server.status}
                    </span>
                  </span>
                </td>
                <td className="py-0.5 pr-2 text-[var(--color-mute)]">
                  {server.check_status ?? "—"}
                  {server.check_failures > 0 && (
                    <span className="ml-1 text-[var(--color-drain)]">({server.check_failures})</span>
                  )}
                </td>
                <td className="py-0.5 pr-2 text-right text-[var(--color-mute)]">
                  {server.weight ?? "—"}
                </td>
                <td className="py-0.5 pr-2 text-right text-[var(--color-mute)]">
                  {server.sessions_current.toLocaleString()}
                </td>
                <td className={`py-0.5 pr-2 text-right ${
                  server.queue_current > 0 ? "text-[var(--color-drain)]" : "text-[var(--color-mute)]"
                }`}>
                  {server.queue_current || "—"}
                </td>
                <td className={`py-0.5 text-right ${
                  errors ? "text-[var(--color-down)]" : "text-[var(--color-mute)]"
                }`}>
                  {errors || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
