import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import Metrics from "./Metrics";
import { installEventSource, snapshot } from "../test/sse";
import { renderWithProviders } from "../test/render";
import type { NodeSnapshot } from "../types";

const NODES: NodeSnapshot[] = [
  snapshot({ node_id: 1, node_name: "lb-edge-1", group: "edge", reachable: true }),
  snapshot({ node_id: 2, node_name: "lb-edge-2", group: "edge", reachable: true }),
  snapshot({ node_id: 3, node_name: "lb-internal-1", group: "internal", reachable: false }),
];

const panel = (title: string) => ({
  key: title, title, unit: "sessions", description: "d",
  series: [{ name: "current", points: [[1700000000, 1] as [number, number | null]] }],
});

/** Records which node's metrics were asked for. */
function installApi(nodes: NodeSnapshot[] = NODES) {
  const metricsFor: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    if (path === "/fleet") return ok({ nodes, summary: null });
    if (path === "/metrics/status") return ok({ enabled: true });
    const m = path.match(/^\/nodes\/(\d+)\/metrics$/);
    if (m) {
      metricsFor.push(Number(m[1]));
      return ok({ node_id: Number(m[1]), minutes: 60, panels: [panel("Sessions")] });
    }
    return ok({});
  }));
  return metricsFor;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const show = () =>
  renderWithProviders(
    <Routes><Route path="/metrics" element={<Metrics />} /></Routes>,
    { route: "/metrics" },
  );

describe("Metrics page", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "test-token");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists every node in the picker, grouped", async () => {
    installApi();
    show();

    const picker = await screen.findByRole("combobox", { name: "Node to chart" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["lb-edge-1", "lb-edge-2", "lb-internal-1"]);
    // Grouped, because a fleet of any size is read group-first.
    expect(picker.querySelectorAll("optgroup")).toHaveLength(2);
  });

  it("charts the first node before anything is chosen", async () => {
    const metricsFor = installApi();
    show();
    await waitFor(() => expect(metricsFor).toContain(1));
    expect(metricsFor).not.toContain(2);
  });

  it("charts the node picked from the dropdown", async () => {
    const user = userEvent.setup();
    const metricsFor = installApi();
    show();
    await screen.findByRole("combobox", { name: "Node to chart" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to chart" }), "2");

    await waitFor(() => expect(metricsFor).toContain(2));
  });

  it("remembers the choice for the next visit", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByRole("combobox", { name: "Node to chart" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to chart" }), "3");

    await waitFor(() =>
      expect(localStorage.getItem("haproxyops.metricsNode")).toBe("3"));
  });

  it("falls back to a real node when the remembered one is gone", async () => {
    // A node can be deleted between visits; a dangling id must not blank the page.
    localStorage.setItem("haproxyops.metricsNode", "999");
    const metricsFor = installApi();
    show();

    await waitFor(() => expect(metricsFor).toContain(1));
    expect(await screen.findByRole("combobox", { name: "Node to chart" }))
      .toHaveValue("1");
  });

  it("warns that an unreachable node's graphs are history, not current state", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByRole("combobox", { name: "Node to chart" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Node to chart" }), "3");

    // Prometheus keeps scraping history, so the last datapoint would otherwise
    // read as the node's present state.
    expect(await screen.findByText(/is unreachable right now/)).toBeInTheDocument();
  });

  it("points at Nodes when the fleet is empty", async () => {
    installApi([]);
    show();

    expect(await screen.findByText(/No nodes registered yet/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Node to chart" })).not.toBeInTheDocument();
  });

  it("links through to the selected node's page", async () => {
    installApi();
    show();

    const link = await screen.findByRole("link", { name: /Open lb-edge-1/ });
    expect(link).toHaveAttribute("href", "/nodes/1");
  });
});
