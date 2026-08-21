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
}

export interface ServiceGrouping {
  services: Service[];
  /** Backends no frontend routes to. Still shown - never silently dropped. */
  orphans: BackendStat[];
  /** Backends reachable from more than one frontend. */
  shared: Set<string>;
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
    for (const name of frontend.routed_backends ?? []) {
      const backend = byName.get(name);
      if (backend) {
        backends.push(backend);
        useCount.set(name, (useCount.get(name) ?? 0) + 1);
      } else {
        missing.push(name);
      }
    }
    return { key: frontend.name, frontend, backends, missing };
  });

  const shared = new Set(
    [...useCount.entries()].filter(([, n]) => n > 1).map(([name]) => name),
  );
  const orphans = node.backends.filter((b) => !useCount.has(b.name));

  return {
    services,
    orphans,
    shared,
    unavailable: !(node.capabilities ?? []).includes("read_config"),
  };
}

/** Worst status among a service's parts, for the section's own indicator. */
export function serviceHealth(service: Service): "down" | "degraded" | "ok" {
  const down = service.backends.some(
    (b) => b.servers_total > 0 && b.servers_up === 0,
  );
  if (down || service.missing.length > 0) return "down";
  const degraded = service.backends.some((b) => b.servers_up < b.servers_total);
  return degraded ? "degraded" : "ok";
}
