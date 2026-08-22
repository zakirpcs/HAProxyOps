import { describe, expect, it } from "vitest";
import { describe as describeConfig, diffConfigs, flatten } from "./configdiff";

const node = (frontends: unknown[] = [], backends: unknown[] = []) =>
  ({ frontends, backends }) as never;

describe("flatten", () => {
  it("turns nested config into dotted paths", () => {
    expect(flatten({ name: "b", httpchk_params: { method: "GET", uri: "/" } }))
      .toEqual({ "httpchk_params.method": "GET", "httpchk_params.uri": "/" });
  });

  it("drops null, because unset and null mean the same thing in HAProxy", () => {
    // Reporting these as different would invent a difference that is not real.
    expect(flatten({ name: "f", stats_show_node_name: null })).toEqual({});
  });

  it("ignores fields that say nothing about behaviour", () => {
    // `from` names an anonymous defaults section the API numbers per file, so
    // two identical configs routinely disagree on it.
    expect(flatten({ name: "f", from: "unnamed_defaults_1", x: 1 })).toEqual({ x: "1" });
  });

  it("indexes arrays rather than sorting them", () => {
    // Rule order is behaviour in HAProxy; sorting would hide a reordering.
    expect(flatten({ name: "f", rules: ["a", "b"] }))
      .toEqual({ "rules[0]": "a", "rules[1]": "b" });
  });
});

describe("diffConfigs", () => {
  it("reports two identical nodes as the same", () => {
    const cfg = node([{ name: "http-in", default_backend: "app" }], [{ name: "app" }]);
    const diff = diffConfigs(cfg, cfg);
    expect(diff.changed).toBe(0);
    expect(diff.frontends[0].status).toBe("same");
  });

  it("names the field that differs, with both values", () => {
    const diff = diffConfigs(
      node([{ name: "http-in", default_backend: "app" }]),
      node([{ name: "http-in", default_backend: "other" }]),
    );
    expect(diff.frontends[0].status).toBe("differs");
    expect(diff.frontends[0].fields).toEqual([
      { path: "default_backend", a: "app", b: "other" },
    ]);
  });

  it("flags a proxy that exists on only one node", () => {
    const diff = diffConfigs(node([{ name: "a" }, { name: "b" }]), node([{ name: "a" }]));
    expect(diff.frontends.find((f) => f.name === "b")?.status).toBe("only-a");
    expect(diff.changed).toBe(1);
  });

  it("flags a proxy added on the other node", () => {
    const diff = diffConfigs(node([{ name: "a" }]), node([{ name: "a" }, { name: "new" }]));
    expect(diff.frontends.find((f) => f.name === "new")?.status).toBe("only-b");
  });

  it("matches by name, not by position", () => {
    // "the same backend on both nodes" means the same name; file order is
    // meaningless across hosts.
    const diff = diffConfigs(
      node([{ name: "a" }, { name: "z" }]),
      node([{ name: "z" }, { name: "a" }]),
    );
    expect(diff.changed).toBe(0);
  });

  it("does not report a difference between null and absent", () => {
    const diff = diffConfigs(
      node([{ name: "f", opt: null }]),
      node([{ name: "f" }]),
    );
    expect(diff.changed).toBe(0);
  });

  it("compares frontends and backends separately", () => {
    // A frontend and a backend can share a name; conflating them would produce
    // a nonsense diff.
    const diff = diffConfigs(
      node([{ name: "x", a: 1 }], [{ name: "x", a: 2 }]),
      node([{ name: "x", a: 1 }], [{ name: "x", a: 3 }]),
    );
    expect(diff.frontends[0].status).toBe("same");
    expect(diff.backends[0].status).toBe("differs");
  });

  it("finds a nested difference", () => {
    const diff = diffConfigs(
      node([], [{ name: "app", httpchk_params: { uri: "/" } }]),
      node([], [{ name: "app", httpchk_params: { uri: "/health" } }]),
    );
    expect(diff.backends[0].fields).toEqual([
      { path: "httpchk_params.uri", a: "/", b: "/health" },
    ]);
  });

  it("survives a node with no proxies at all", () => {
    expect(() => diffConfigs(node(), node())).not.toThrow();
    expect(diffConfigs(node(), node()).changed).toBe(0);
  });
});

describe("describe", () => {
  it("lists one node's settings sorted by name", () => {
    const out = describeConfig(node([{ name: "z" }, { name: "a", opt: 1 }]));
    expect(out.frontends.map((f) => f.name)).toEqual(["a", "z"]);
    expect(out.frontends[0].fields).toEqual([{ path: "opt", a: "1", b: null }]);
  });
});
