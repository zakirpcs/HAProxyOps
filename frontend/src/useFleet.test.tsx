import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link } from "react-router-dom";
import { FleetProvider, useFleet } from "./useFleet";
import { FakeEventSource, installEventSource, installFetch, snapshot } from "./test/sse";

const FLEET = { nodes: [snapshot()], summary: null };

function Probe({ label }: { label: string }) {
  const { nodes, connected } = useFleet();
  return (
    <div>
      <span data-testid={`${label}-count`}>{nodes.length}</span>
      <span data-testid={`${label}-connected`}>{String(connected)}</span>
    </div>
  );
}

/** Two consumers plus routing, i.e. the shape the real app has. */
function Harness() {
  return (
    <FleetProvider>
      {/* Stands in for the shell's status indicator: always mounted. */}
      <Probe label="shell" />
      <Link to="/">fleet</Link>
      <Link to="/nodes/1">node</Link>
      <Routes>
        <Route path="/" element={<Probe label="page" />} />
        <Route path="/nodes/1" element={<Probe label="node" />} />
      </Routes>
    </FleetProvider>
  );
}

describe("FleetProvider", () => {
  beforeEach(() => {
    installEventSource();
    installFetch({ "/fleet": FLEET, "/auth/me": { username: "admin", role: "admin" } });
    localStorage.setItem("haproxyops.token", "test-token");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens exactly one stream however many components read it", async () => {
    render(<MemoryRouter initialEntries={["/"]}><Harness /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("shell-count")).toHaveTextContent("1"));
    // Two live consumers - the shell probe and the routed page - one connection.
    expect(screen.getByTestId("page-count")).toHaveTextContent("1");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("keeps the same stream across client-side navigation", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<MemoryRouter initialEntries={["/"]}><Harness /></MemoryRouter>);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];

    await user.click(screen.getByText("node"));
    await screen.findByTestId("node-count");
    await user.click(screen.getByText("fleet"));
    await screen.findByTestId("page-count");

    // The regression this guards: a hook-per-page opened a stream per page, so
    // this count climbed with every navigation.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]).toBe(first);
    expect(first.closed).toBe(false);
  });

  it("closes the stream when the provider unmounts", async () => {
    const { unmount } = render(<MemoryRouter><Harness /></MemoryRouter>);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    unmount();

    expect(FakeEventSource.open).toHaveLength(0);
  });

  it("applies snapshots to every consumer at once", async () => {
    render(<MemoryRouter initialEntries={["/"]}><Harness /></MemoryRouter>);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.connect();
      source.emit("snapshot", snapshot({ node_id: 2, node_name: "lb-edge-2" }));
    });

    await waitFor(() => expect(screen.getByTestId("shell-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("page-count")).toHaveTextContent("2");
    expect(screen.getByTestId("shell-connected")).toHaveTextContent("true");
  });

  it("holds updates without applying them while paused", async () => {
    localStorage.setItem("haproxyops.refresh", "paused");
    render(<MemoryRouter initialEntries={["/"]}><Harness /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("shell-count")).toHaveTextContent("1"));
    const source = FakeEventSource.instances[0];

    act(() => source.emit("snapshot", snapshot({ node_id: 2, node_name: "lb-edge-2" })));

    // Still one visible: paused freezes the view, and the stream stays open so
    // resuming shows current state rather than replaying a backlog.
    expect(screen.getByTestId("shell-count")).toHaveTextContent("1");
    expect(source.closed).toBe(false);
  });

  it("throws when used outside the provider", () => {
    // Otherwise the failure mode is an empty fleet that reads as a backend outage.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe label="orphan" />)).toThrow(/must be used inside/);
    quiet.mockRestore();
  });
});
