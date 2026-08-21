import { describe, expect, it, vi } from "vitest";
import { applyBulk, assessImpact, keyOf, parseKey } from "./bulk";
import type { BackendStat, ServerStat } from "./types";

const srv = (name: string, up: boolean, backup = false): ServerStat =>
  ({ name, backend: "b", status: up ? "UP" : "DOWN", is_up: up, backup, active: !backup,
     address: null, weight: 100, sessions_current: 0, sessions_max: 0, sessions_total: 0,
     queue_current: 0, bytes_in: 0, bytes_out: 0, connection_errors: 0, response_errors: 0,
     check_status: null, check_failures: 0, downtime_seconds: 0, last_change_seconds: 0 } as ServerStat);

const be = (name: string, servers: ServerStat[]): BackendStat =>
  ({ name, status: "UP", servers, servers_up: servers.filter((s) => s.is_up).length,
     servers_total: servers.length, sessions_current: 0, sessions_max: 0, sessions_total: 0,
     queue_current: 0, bytes_in: 0, bytes_out: 0, connection_errors: 0,
     response_errors: 0 } as BackendStat);

describe("assessImpact", () => {
  it("flags a backend that would be left with nothing up", () => {
    const backends = [be("app", [srv("a", true), srv("b", true)])];
    const impact = assessImpact(backends, [
      { backend: "app", server: "a" }, { backend: "app", server: "b" },
    ], "drain");
    // The whole point: one at a time this is obvious, twelve at once is not.
    expect(impact.emptied).toEqual(["app"]);
  });

  it("does not flag a backend that keeps capacity", () => {
    const backends = [be("app", [srv("a", true), srv("b", true), srv("c", true)])];
    const impact = assessImpact(backends, [{ backend: "app", server: "a" }], "drain");
    expect(impact.emptied).toEqual([]);
    expect(impact.reduced).toEqual(["app"]);
    expect(impact.perBackend[0]).toMatchObject({ upBefore: 3, upAfter: 2 });
  });

  it("ignores backup servers when counting capacity", () => {
    // A standby is meant to be down; counting it would hide the outage.
    const backends = [be("app", [srv("a", true), srv("bck", false, true)])];
    const impact = assessImpact(backends, [{ backend: "app", server: "a" }], "maint");
    expect(impact.emptied).toEqual(["app"]);
  });

  it("treats ready as restoring rather than removing", () => {
    const backends = [be("app", [srv("a", false), srv("b", true)])];
    const impact = assessImpact(backends, [{ backend: "app", server: "a" }], "ready");
    expect(impact.perBackend[0]).toMatchObject({ upBefore: 1, upAfter: 2 });
    expect(impact.emptied).toEqual([]);
  });

  it("reports each backend separately", () => {
    const backends = [
      be("app", [srv("a", true), srv("b", true)]),
      be("api", [srv("c", true)]),
    ];
    const impact = assessImpact(backends, [
      { backend: "app", server: "a" }, { backend: "api", server: "c" },
    ], "drain");
    expect(impact.perBackend.map((b) => b.backend).sort()).toEqual(["api", "app"]);
    expect(impact.emptied).toEqual(["api"]);
  });

  it("ignores an already-down server when judging what is lost", () => {
    const backends = [be("app", [srv("a", false), srv("b", true)])];
    const impact = assessImpact(backends, [{ backend: "app", server: "a" }], "maint");
    expect(impact.emptied).toEqual([]);
    expect(impact.reduced).toEqual([]);
  });
});

describe("applyBulk", () => {
  it("runs every target and keeps the caller's order", async () => {
    const targets = [1, 2, 3, 4, 5].map((n) => ({ backend: "app", server: `s${n}` }));
    const results = await applyBulk(targets, async () => {}, 2);
    expect(results.map((r) => r.target.server)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("reports partial failure instead of abandoning the rest", async () => {
    const targets = ["a", "b", "c"].map((s) => ({ backend: "app", server: s }));
    const run = vi.fn(async (t: { server: string }) => {
      if (t.server === "b") throw new Error("node refused");
    });
    const results = await applyBulk(targets, run, 1);

    // One refusal must not hide the two that worked.
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: "node refused" });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0, peak = 0;
    const targets = Array.from({ length: 12 }, (_, i) => ({ backend: "app", server: `s${i}` }));
    await applyBulk(targets, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    }, 4);
    // Unbounded, this would open a dozen connections to one management API.
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("keys", () => {
  it("round-trips a backend and server", () => {
    expect(parseKey(keyOf("app-back", "web1"))).toEqual({ backend: "app-back", server: "web1" });
  });
});
