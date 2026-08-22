import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Config from "./Config";
import { renderWithProviders } from "../test/render";
import { installEventSource, snapshot } from "../test/sse";

const NODES = [
  snapshot({ node_id: 1, node_name: "lb-edge-1", group: "edge" }),
  snapshot({ node_id: 2, node_name: "lb-edge-2", group: "edge" }),
];

const CONFIGS: Record<number, unknown> = {
  1: { frontends: [{ name: "http-in", default_backend: "app" }],
       backends: [{ name: "app", httpchk_params: { uri: "/" } }] },
  2: { frontends: [{ name: "http-in", default_backend: "app" }],
       backends: [{ name: "app", httpchk_params: { uri: "/health" } }] },
};

function installApi(configs = CONFIGS, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    if (path === "/fleet") return ok({ nodes: NODES, summary: null });
    const m = path.match(/^\/nodes\/(\d+)\/config$/);
    if (m) {
      if (status !== 200) return { ok: false, status, json: async () => ({ detail: `HTTP ${status}` }) };
      return ok(configs[Number(m[1])]);
    }
    return ok({});
  }));
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const show = () => renderWithProviders(<Config />, { route: "/config" });

describe("Config page", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "t");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows one node's settings when nothing is being compared", async () => {
    installApi();
    show();
    expect(await screen.findByText("http-in")).toBeInTheDocument();
    expect(screen.getByText("httpchk_params.uri")).toBeInTheDocument();
  });

  it("names the setting that differs, with the value from each node", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("http-in");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to compare against" }), "2");

    expect(await screen.findByText("1 difference")).toBeInTheDocument();
    expect(screen.getByText("httpchk_params.uri")).toBeInTheDocument();
    expect(screen.getByText("/health")).toBeInTheDocument();
  });

  it("says so plainly when two nodes match", async () => {
    const user = userEvent.setup();
    installApi({ 1: CONFIGS[1], 2: CONFIGS[1] });
    show();
    await screen.findByText("http-in");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to compare against" }), "2");

    expect(await screen.findByText("identical")).toBeInTheDocument();
  });

  it("flags a proxy declared on only one node", async () => {
    const user = userEvent.setup();
    installApi({
      1: { frontends: [{ name: "http-in" }, { name: "extra" }], backends: [] },
      2: { frontends: [{ name: "http-in" }], backends: [] },
    });
    show();
    await screen.findByText("http-in");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to compare against" }), "2");

    expect(await screen.findByText(/not declared on lb-edge-2/)).toBeInTheDocument();
  });

  it("explains a transport that cannot read configuration", async () => {
    installApi(CONFIGS, 501);
    show();
    // A raw "HTTP 501" tells an operator nothing about what to do.
    await waitFor(() =>
      expect(screen.getByText(/cannot read configuration/)).toBeInTheDocument());
  });

  it("cannot compare a node with itself", async () => {
    installApi();
    show();
    await screen.findByText("http-in");
    const compare = screen.getByRole("combobox", { name: "Node to compare against" });
    const values = [...compare.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(values).not.toContain("1");
  });
});
