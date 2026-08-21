import { describe, expect, it } from "vitest";
import { groupServices, serviceHealth } from "./services";
import type { BackendStat, FrontendStat, NodeSnapshot } from "./types";

const be = (name: string, up: number, total: number): BackendStat => ({
  name, status: "UP", sessions_current: 0, sessions_max: 0, sessions_total: 0,
  queue_current: 0, bytes_in: 0, bytes_out: 0, connection_errors: 0,
  response_errors: 0, servers: [], servers_up: up, servers_total: total,
} as BackendStat);

const fe = (name: string, def: string | null, rules: string[] = []): FrontendStat => ({
  name, status: "OPEN", sessions_current: 0, sessions_max: 0, sessions_limit: 0,
  sessions_total: 0, bytes_in: 0, bytes_out: 0, request_errors: 0,
  requests_denied: 0, rate: 0, default_backend: def, rule_backends: rules,
  routed_backends: [...(def ? [def] : []), ...rules.filter((r) => r !== def)],
} as FrontendStat);

const node = (
  frontends: FrontendStat[], backends: BackendStat[], caps = ["read_config"],
): NodeSnapshot => ({ frontends, backends, capabilities: caps } as NodeSnapshot);

describe("groupServices", () => {
  it("groups the demo topology by what each frontend routes to", () => {
    const g = groupServices(node(
      [fe("stats", null), fe("http-in", "app-back"), fe("api-in", "app-back", ["health-back"])],
      [be("app-back", 3, 4), be("health-back", 1, 1)],
    ));

    expect(g.services.map((s) => s.frontend.name)).toEqual(["stats", "http-in", "api-in"]);
    expect(g.services[0].backends).toHaveLength(0);
    expect(g.services[1].backends.map((b) => b.name)).toEqual(["app-back"]);
    expect(g.services[2].backends.map((b) => b.name)).toEqual(["app-back", "health-back"]);
  });

  it("marks a backend reachable from several frontends as shared", () => {
    const g = groupServices(node(
      [fe("http-in", "app-back"), fe("https-in", "app-back")],
      [be("app-back", 2, 2)],
    ));
    // Without this the same backend under two services reads as a duplicate bug.
    expect([...g.shared]).toEqual(["app-back"]);
  });

  it("surfaces a backend no frontend routes to rather than dropping it", () => {
    const g = groupServices(node([fe("http-in", "app-back")], [be("app-back", 2, 2), be("legacy", 1, 1)]));
    expect(g.orphans.map((b) => b.name)).toEqual(["legacy"]);
  });

  it("records a routed backend that reports no stats as missing", () => {
    const g = groupServices(node([fe("http-in", "ghost")], [be("app-back", 2, 2)]));
    expect(g.services[0].missing).toEqual(["ghost"]);
    expect(serviceHealth(g.services[0])).toBe("down");
    expect(g.orphans.map((b) => b.name)).toEqual(["app-back"]);
  });

  it("flags nodes whose transport cannot read configuration", () => {
    const g = groupServices(node([fe("http-in", null)], [be("app-back", 2, 2)], ["read_state"]));
    expect(g.unavailable).toBe(true);
  });

  it("does not duplicate a default_backend that is also a rule target", () => {
    const g = groupServices(node(
      [fe("http-in", "app-back", ["app-back", "health-back"])],
      [be("app-back", 2, 2), be("health-back", 1, 1)],
    ));
    expect(g.services[0].backends.map((b) => b.name)).toEqual(["app-back", "health-back"]);
    // Counted once, so a self-reference must not look shared.
    expect([...g.shared]).toEqual([]);
  });
});

describe("serviceHealth", () => {
  it.each([
    ["all servers up", 2, 2, "ok"],
    ["some servers down", 1, 2, "degraded"],
    ["no servers up", 0, 2, "down"],
  ])("%s -> %s", (_label, up, total, expected) => {
    const g = groupServices(node([fe("f", "a")], [be("a", up as number, total as number)]));
    expect(serviceHealth(g.services[0])).toBe(expected);
  });

  it("treats an empty backend as healthy rather than down", () => {
    // 0/0 is a backend with no servers configured, not a total outage.
    const g = groupServices(node([fe("f", "a")], [be("a", 0, 0)]));
    expect(serviceHealth(g.services[0])).toBe("ok");
  });
});
