import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FleetStatusView } from "./FleetStatus";
import type { FleetSummary } from "../types";

const summary = (over: Partial<FleetSummary> = {}): FleetSummary => ({
  nodes_total: 14, nodes_up: 14, nodes_down: 0, frontends: 40, backends: 30,
  servers_total: 80, servers_down: 0, backups_down: 0, sessions_current: 120, ...over,
});

const show = (props: Parameters<typeof FleetStatusView>[0]) =>
  render(<MemoryRouter><FleetStatusView {...props} /></MemoryRouter>);

describe("FleetStatusView", () => {
  it("reads healthy when everything is up and the stream is live", () => {
    show({ summary: summary(), connected: true, refresh: "live", pending: 0 });
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.queryByText(/down/)).not.toBeInTheDocument();
  });

  it("counts servers down on otherwise reachable nodes", () => {
    // The common case, and invisible from the node totals alone.
    show({ summary: summary({ servers_down: 3 }), connected: true, refresh: "live", pending: 0 });
    expect(screen.getByText("3 srv down")).toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
  });

  it("counts unreachable nodes separately from unreachable servers", () => {
    show({
      summary: summary({ nodes_up: 12, nodes_down: 2, servers_down: 9 }),
      connected: true, refresh: "live", pending: 0,
    });
    expect(screen.getByText("12/14")).toBeInTheDocument();
    expect(screen.getByText("2 down")).toBeInTheDocument();
    expect(screen.getByText("9 srv down")).toBeInTheDocument();
  });

  it("shows the held-update count while paused", () => {
    show({ summary: summary(), connected: true, refresh: "paused", pending: 7 });
    expect(screen.getByText(/paused/)).toHaveTextContent("7");
  });

  it("reports a dropped stream even while the fleet itself looks fine", () => {
    // The failure this guards: a disconnected client showing stale green.
    show({ summary: summary(), connected: false, refresh: "live", pending: 0 });
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("says so while the first fetch is still in flight", () => {
    show({ summary: null, connected: false, refresh: "live", pending: 0 });
    expect(screen.getByText(/Loading fleet/)).toBeInTheDocument();
  });

  it("spells the whole state out in the tooltip", () => {
    show({
      summary: summary({ nodes_up: 12, nodes_down: 2, servers_down: 9 }),
      connected: false, refresh: "live", pending: 0,
    });
    expect(screen.getByRole("link")).toHaveAttribute(
      "title",
      "12/14 nodes reachable · 9 of 80 servers down · stream disconnected",
    );
  });
});
