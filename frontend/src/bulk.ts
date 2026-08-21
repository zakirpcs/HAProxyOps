import type { AdminState, BackendStat } from "./types";

/** A server picked out for a bulk change, identified by where it lives. */
export interface Selected {
  backend: string;
  server: string;
}

/**
 * Key for one server. A space separates the two halves: HAProxy config is
 * whitespace-delimited, so neither a proxy nor a server name can contain one.
 */
export const keyOf = (backend: string, server: string) => `${backend} ${server}`;
export const parseKey = (key: string): Selected => {
  const [backend, server] = key.split(" ");
  return { backend, server };
};

export interface BackendImpact {
  backend: string;
  /** Active servers currently up. */
  upBefore: number;
  /** Active servers still up once the change lands. */
  upAfter: number;
  total: number;
  selected: number;
}

export interface Impact {
  perBackend: BackendImpact[];
  /** Backends this would leave with no active server up at all. */
  emptied: string[];
  /** Backends losing capacity but not all of it. */
  reduced: string[];
}

/**
 * What a bulk change would actually do, backend by backend.
 *
 * The point is the `emptied` list. Draining a handful of servers one at a time
 * makes the last one obvious; selecting twelve at once hides it completely, and
 * taking every active server out of a backend is an outage, not a maintenance
 * step. Backups are excluded from the counts for the same reason they are
 * excluded from the degraded state: a standby is meant to be down, and counting
 * it as capacity would mask exactly the case this is meant to catch.
 */
export function assessImpact(
  backends: BackendStat[],
  selected: Selected[],
  state: AdminState,
): Impact {
  const byBackend = new Map<string, Set<string>>();
  for (const s of selected) {
    byBackend.set(s.backend, (byBackend.get(s.backend) ?? new Set()).add(s.server));
  }

  const perBackend: BackendImpact[] = [];
  for (const backend of backends) {
    const picked = byBackend.get(backend.name);
    if (!picked) continue;

    const active = backend.servers.filter((s) => !s.backup);
    const upBefore = active.filter((s) => s.is_up).length;
    // "ready" restores, so it can only raise the count; drain and maint remove
    // the selected servers from rotation.
    const upAfter = state === "ready"
      ? active.filter((s) => s.is_up || picked.has(s.name)).length
      : active.filter((s) => s.is_up && !picked.has(s.name)).length;

    perBackend.push({
      backend: backend.name,
      upBefore,
      upAfter,
      total: active.length,
      selected: picked.size,
    });
  }

  return {
    perBackend,
    emptied: perBackend.filter((b) => b.upBefore > 0 && b.upAfter === 0).map((b) => b.backend),
    reduced: perBackend
      .filter((b) => b.upAfter < b.upBefore && b.upAfter > 0)
      .map((b) => b.backend),
  };
}

export interface BulkResult {
  target: Selected;
  ok: boolean;
  error?: string;
}

/**
 * Apply one change to many servers, a few at a time.
 *
 * Bounded concurrency rather than `Promise.all`: a bulk action on a large
 * backend would otherwise open dozens of simultaneous requests against a single
 * load balancer's management API, which is the one thing you least want to
 * overload while taking servers out of rotation.
 *
 * Never rejects. A partial failure is the expected case - one server refusing
 * is not a reason to hide the eleven that worked - so every outcome is
 * reported and the caller decides what to say.
 */
export async function applyBulk(
  targets: Selected[],
  run: (target: Selected) => Promise<unknown>,
  concurrency = 4,
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  const queue = [...targets];

  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const target = next;
      try {
        await run(target);
        results.push({ target, ok: true });
      } catch (e) {
        results.push({
          target,
          ok: false,
          error: e instanceof Error ? e.message : "Failed",
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  // Restore the caller's order; workers finish out of order.
  const rank = new Map(targets.map((t, i) => [keyOf(t.backend, t.server), i]));
  return results.sort(
    (a, b) =>
      (rank.get(keyOf(a.target.backend, a.target.server)) ?? 0) -
      (rank.get(keyOf(b.target.backend, b.target.server)) ?? 0),
  );
}
