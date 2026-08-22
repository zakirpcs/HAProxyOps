import type { BackendStat, FrontendStat, NodeSnapshot } from "./types";

/**
 * One frontend and the backends it can route to.
 *
 * "Service" is a view, not a thing HAProxy models. A backend is frequently
 * shared between frontends (an edge node terminating :80 and :443 into the
 * same pool), so a backend can appear in more than one service - grouping
 * here means "reachable from", never "owned by".
 */
export interface Service {
  key: string;
  frontend: FrontendStat;
  backends: BackendStat[];
  /** Routed to but absent from the stats: config and runtime disagree. */
  missing: string[];
  /**
   * Rule targets that are expressions rather than backend names, e.g.
   * `use_backend %[req.hdr(x-tenant),lower]`. The backend is chosen per
   * request, so no single one can be shown - but it is not missing either.
   */
  dynamic: string[];
}

/**
 * Whether a rule target names a backend or computes one.
 *
 * HAProxy allows a fetch expression as a `use_backend` target, and the Data
 * Plane API reports the expression verbatim as the rule's name. Treating that
 * as a backend that failed to report would raise a false alarm about the
 * config and the runtime disagreeing, when nothing is wrong at all.
 */
export function isDynamicTarget(name: string): boolean {
  return name.includes("%") || name.includes("[") || name.includes("$");
}

export interface ServiceGrouping {
  services: Service[];
  /** Backends no frontend routes to. Still shown - never silently dropped. */
  orphans: BackendStat[];
  /** Backends reachable from more than one frontend. */
  shared: Set<string>;
  /**
   * Frontends running a Lua action. A Lua script can select a backend and the
   * configuration never says which, so an unrouted backend on such a node may
   * be perfectly well routed - just not visibly.
   */
  luaFrontends: string[];
  /**
   * True when the node's transport cannot read configuration, so there is no
   * routing to group by. Distinguished from "config read fine, and nothing is
   * routed" because the two need different explanations in the UI.
   */
  unavailable: boolean;
}

export function groupServices(node: NodeSnapshot): ServiceGrouping {
  const byName = new Map(node.backends.map((b) => [b.name, b]));
  // Counted, not just flagged: the count is what distinguishes a shared
  // backend from one that simply appears once.
  const useCount = new Map<string, number>();

  const services: Service[] = node.frontends.map((frontend) => {
    const backends: BackendStat[] = [];
    const missing: string[] = [];
    const dynamic: string[] = [];
    for (const name of frontend.routed_backends ?? []) {
      const backend = byName.get(name);
      if (backend) {
        backends.push(backend);
        useCount.set(name, (useCount.get(name) ?? 0) + 1);
      } else if (isDynamicTarget(name)) {
        dynamic.push(name);
      } else {
        missing.push(name);
      }
    }
    return { key: frontend.name, frontend, backends, missing, dynamic };
  });

  const shared = new Set(
    [...useCount.entries()].filter(([, n]) => n > 1).map(([name]) => name),
  );
  const orphans = node.backends.filter((b) => !useCount.has(b.name));

  return {
    services,
    orphans,
    shared,
    luaFrontends: node.frontends
      .filter((f) => (f.lua_actions ?? []).length > 0)
      .map((f) => f.name),
    unavailable: !(node.capabilities ?? []).includes("read_config"),
  };
}

/** Worst status among a service's parts, for the section's own indicator. */
export function serviceHealth(service: Service): "down" | "degraded" | "ok" {
  // Active servers only, matching the rule the fleet table uses for a node: a
  // backup is meant to be down while the primaries are healthy. Counting it
  // here made a service read "degraded" on a node the fleet showed as "UP" -
  // the same fact, two answers.
  // Falls back to the reported totals when the server list is absent: a
  // transport that gives counts but no members should still be judged, not
  // silently read as healthy.
  const counts = (b: BackendStat): { up: number; total: number } => {
    if (!b.servers?.length) return { up: b.servers_up, total: b.servers_total };
    const active = b.servers.filter((s) => !s.backup);
    return { up: active.filter((s) => s.is_up).length, total: active.length };
  };

  const down = service.backends.some((b) => {
    const { up, total } = counts(b);
    return total > 0 && up === 0;
  });
  if (down || service.missing.length > 0) return "down";

  const degraded = service.backends.some((b) => {
    const { up, total } = counts(b);
    return up < total;
  });
  return degraded ? "degraded" : "ok";
}
