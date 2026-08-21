import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Fleet from "./Fleet";
import { FleetProvider } from "../useFleet";
import { installEventSource, installFetch, snapshot } from "../test/sse";
import type { BackendStat, NodeSnapshot, ServerStat } from "../types";

const server = (name: string, up: boolean, backup = false): ServerStat => ({
  name, backend: "app-back", status: up ? "UP" : "DOWN", address: "10.0.0.1:80",
  weight: 100, active: !backup, backup, sessions_current: 0, sessions_max: 0,
  sessions_total: 0, queue_current: 0, bytes_in: 0, bytes_out: 0,
  connection_errors: 0, response_errors: 0, check_status: "L7OK",
  check_failures: 0, downtime_seconds: 0, last_change_seconds: 0, is_up: up,
} as ServerStat);

const backend = (servers: ServerStat[]): BackendStat => ({
  name: "app-back", status: "UP", sessions_current: 0, sessions_max: 0,
  sessions_total: 0, queue_current: 0, bytes_in: 0, bytes_out: 0,
  connection_errors: 0, response_errors: 0, servers,
  servers_up: servers.filter((s) => s.is_up).length, servers_total: servers.length,
} as BackendStat);

const frontend = (sessions: number) => ({
  name: "http-in", status: "OPEN", sessions_current: sessions, sessions_max: 0,
  sessions_limit: 0, sessions_total: 0, bytes_in: 0, bytes_out: 0,
  request_errors: 0, requests_denied: 0, rate: 0,
  default_backend: "app-back", rule_backends: [], routed_backends: ["app-back"],
});

/**
 * Four nodes spanning the states the table sorts by: unreachable, degraded and
 * healthy, across two groups, with distinct session counts.
 */
const NODES: NodeSnapshot[] = [
  snapshot({
    node_id: 1, node_name: "lb-edge-1", group: "edge", reachable: true,
    frontends: [frontend(10)] as never, backends: [backend([server("a", true), server("b", true)])],
  }),
  snapshot({
    node_id: 2, node_name: "lb-edge-2", group: "edge", reachable: true,
    frontends: [frontend(5)] as never, backends: [backend([server("a", true), server("b", false)])],
  }),
  snapshot({
    node_id: 3, node_name: "lb-internal-1", group: "internal", reachable: false,
    error: "connection refused", frontends: [], backends: [],
  }),
  snapshot({
    node_id: 4, node_name: "web-gw", group: "internal", reachable: true,
    frontends: [frontend(50)] as never, backends: [backend([server("a", true)])],
  }),
];

/** Node names in the order the table currently renders them. */
function rowOrder(names: string[] = NODES.map((n) => n.node_name)): string[] {
  return screen
    .getAllByRole("row")
    .map((row) => row.textContent ?? "")
    .map((text) => names.find((name) => text.includes(name)))
    .filter((name): name is string => Boolean(name));
}

function show(nodes: NodeSnapshot[] = NODES) {
  installFetch({ "/fleet": { nodes, summary: null } });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <FleetProvider><Fleet /></FleetProvider>
    </MemoryRouter>,
  );
}

describe("Fleet table", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "test-token");
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("sorting", () => {
    it("puts problems at the top by default", async () => {
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));
      // down, then degraded, then healthy - the order an operator needs first.
      expect(rowOrder()).toEqual(["lb-internal-1", "lb-edge-2", "lb-edge-1", "web-gw"]);
    });

    it("breaks ties on name so rows do not jitter between polls", async () => {
      // The provider hands rows over sorted by (group, name), and V8's sort is
      // stable - so a tie-break bug hides unless arrival order disagrees with
      // name order. These two tie on every sortable value, and their groups
      // invert their names.
      const tied: NodeSnapshot[] = [
        snapshot({
          node_id: 10, node_name: "zulu-lb", group: "aaa-group", reachable: true,
          frontends: [frontend(7)] as never, backends: [backend([server("a", true)])],
        }),
        snapshot({
          node_id: 11, node_name: "alpha-lb", group: "zzz-group", reachable: true,
          frontends: [frontend(7)] as never, backends: [backend([server("a", true)])],
        }),
      ];
      const names = ["zulu-lb", "alpha-lb"];
      show(tied);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      // Arrival order is zulu-lb (aaa-group) first; name order is alpha-lb.
      expect(rowOrder(names)).toEqual(["alpha-lb", "zulu-lb"]);
    });

    it("sorts by node name ascending, then descending on a second click", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: /^Node/ }));
      expect(rowOrder()).toEqual(["lb-edge-1", "lb-edge-2", "lb-internal-1", "web-gw"]);

      await user.click(screen.getByRole("button", { name: /^Node/ }));
      expect(rowOrder()).toEqual(["web-gw", "lb-internal-1", "lb-edge-2", "lb-edge-1"]);
    });

    it("sorts numeric columns highest-first on the first click", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: /^Sessions/ }));
      // Descending by default: for a metric, the big number is the interesting one.
      expect(rowOrder()).toEqual(["web-gw", "lb-edge-1", "lb-edge-2", "lb-internal-1"]);
    });

    it("exposes sort direction to assistive tech", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: /^Node/ }));
      const header = screen.getByRole("button", { name: /^Node/ }).closest("th")!;
      expect(header).toHaveAttribute("aria-sort", "ascending");

      await user.click(screen.getByRole("button", { name: /^Node/ }));
      expect(header).toHaveAttribute("aria-sort", "descending");
    });
  });

  describe("filtering", () => {
    it("narrows by node name", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "edge-2");
      expect(rowOrder()).toEqual(["lb-edge-2"]);
    });

    it("narrows by group as well as name", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "internal");
      // Matches lb-internal-1 by name and web-gw by its group.
      expect(rowOrder().sort()).toEqual(["lb-internal-1", "web-gw"]);
    });

    it("ignores case and surrounding whitespace", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "  EDGE  ");
      expect(rowOrder().sort()).toEqual(["lb-edge-1", "lb-edge-2"]);
    });

    it("says nothing matched rather than showing an empty table", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "nonexistent");
      expect(screen.getByText(/No nodes match the current filter/)).toBeInTheDocument();
      // Distinct from the empty-fleet message, which points at adding a node.
      expect(screen.queryByText(/No nodes registered yet/)).not.toBeInTheDocument();
    });
  });

  describe("problems only", () => {
    it("keeps unreachable and degraded nodes, drops healthy ones", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: /Problems only/ }));
      expect(rowOrder()).toEqual(["lb-internal-1", "lb-edge-2"]);
    });

    it("combines with the text filter rather than overriding it", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: /Problems only/ }));
      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "edge");
      // lb-internal-1 is a problem but not "edge"; lb-edge-1 is "edge" but healthy.
      expect(rowOrder()).toEqual(["lb-edge-2"]);
    });

    it("reports its state through aria-pressed", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      const toggle = screen.getByRole("button", { name: /Problems only/ });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("backup servers", () => {
    // A backup is meant to be down while the primaries are healthy - that is
    // its whole purpose. Counting it as degradation marks every node with a
    // standby amber forever, and a colour that is always on stops being read.
    const withDeadBackup: NodeSnapshot[] = [
      snapshot({
        node_id: 20, node_name: "standby-lb", group: "edge", reachable: true,
        frontends: [frontend(3)] as never,
        backends: [backend([server("a", true), server("bck", false, true)])],
      }),
      snapshot({
        node_id: 21, node_name: "broken-lb", group: "edge", reachable: true,
        frontends: [frontend(3)] as never,
        backends: [backend([server("a", false), server("bck", false, true)])],
      }),
    ];
    const names = ["standby-lb", "broken-lb"];

    it("does not mark a node degraded for a down backup alone", async () => {
      show(withDeadBackup);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      const row = screen.getByText("standby-lb").closest("tr")!;
      expect(within(row).getByText("UP")).toBeInTheDocument();
      expect(within(row).queryByText("DEGRADED")).not.toBeInTheDocument();
    });

    it("still marks a node degraded when an active server is down", async () => {
      show(withDeadBackup);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      const row = screen.getByText("broken-lb").closest("tr")!;
      expect(within(row).getByText("DEGRADED")).toBeInTheDocument();
    });

    it("surfaces the dead backup rather than hiding it", async () => {
      show(withDeadBackup);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      const row = screen.getByText("standby-lb").closest("tr")!;
      // Quiet, but present: no traffic lost today, no fallback tomorrow.
      expect(within(row).getByText("1 bck")).toBeInTheDocument();
      expect(within(row).getByTitle(/no fallback if the active servers fail/))
        .toBeInTheDocument();
    });

    it("excludes a backup-only node from Problems only", async () => {
      const user = userEvent.setup();
      show(withDeadBackup);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      await user.click(screen.getByRole("button", { name: /Problems only/ }));
      expect(rowOrder(names)).toEqual(["broken-lb"]);
    });

    it("counts problems the same way the filter does", async () => {
      show(withDeadBackup);
      await waitFor(() => expect(rowOrder(names)).toHaveLength(2));

      // The badge is computed separately from the filter, so the two can drift
      // apart and leave the count claiming problems the table will not show.
      expect(screen.getByRole("button", { name: /Problems only/ }))
        .toHaveTextContent("Problems only (1)");
    });
  });

  describe("summary strip", () => {
    it("stays a single row whether or not the backup stat is present", async () => {
      // The old grid was lg:grid-cols-7 with eight possible stats, so the
      // conditional one wrapped to a second row and the summary changed height
      // with fleet health.
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      const strip = screen.getByRole("group", { name: "Fleet summary" });
      const cells = [...strip.children];
      expect(cells.length).toBeGreaterThan(0);
      // Every stat is a direct child of one flex row - no wrapper rows.
      expect(strip).not.toHaveClass("grid");
      for (const cell of cells) expect(cell.parentElement).toBe(strip);
    });

    it("shows the backup stat only when a backup is down", async () => {
      const withBackupDown: NodeSnapshot[] = [
        snapshot({
          node_id: 30, node_name: "standby-lb", group: "edge", reachable: true,
          frontends: [frontend(1)] as never,
          backends: [backend([server("a", true), server("bck", false, true)])],
        }),
      ];
      show(withBackupDown);
      await waitFor(() => expect(rowOrder(["standby-lb"])).toHaveLength(1));

      const strip = screen.getByRole("group", { name: "Fleet summary" });
      expect(within(strip).getByText("Backups")).toBeInTheDocument();
    });

    it("omits the backup stat when every backup is healthy", async () => {
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      const strip = screen.getByRole("group", { name: "Fleet summary" });
      expect(within(strip).queryByText("Backups")).not.toBeInTheDocument();
      expect(within(strip).getByText("Nodes")).toBeInTheDocument();
    });
  });

  describe("grouping", () => {
    it("breaks the table into sections by group", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: "Group" }));

      const bodies = [...document.querySelectorAll("tbody")];
      expect(bodies).toHaveLength(2);
      // The first row of each section is its header: group name plus a count.
      // Matched on the header row specifically - "edge" also appears in the
      // Group column of every row beneath it.
      const headers = bodies.map((b) => within(b).getAllByRole("row")[0].textContent?.trim());
      expect(headers[0]).toMatch(/^edge\s*2$/);
      expect(headers[1]).toMatch(/^internal\s*2$/);
    });

    it("still honours the filter inside groups", async () => {
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rowOrder()).toHaveLength(4));

      await user.click(screen.getByRole("button", { name: "Group" }));
      await user.type(screen.getByPlaceholderText(/Filter by node or group/), "edge");
      expect(rowOrder().sort()).toEqual(["lb-edge-1", "lb-edge-2"]);
    });
  });
});
