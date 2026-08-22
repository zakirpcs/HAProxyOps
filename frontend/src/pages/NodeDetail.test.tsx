import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import NodeDetail from "./NodeDetail";
import { installEventSource, snapshot } from "../test/sse";
import { renderWithProviders } from "../test/render";
import type { BackendStat, NodeSnapshot, ServerStat } from "../types";

const server = (name: string, status: string): ServerStat => ({
  name, backend: "app-back", status, address: "10.0.0.1:80", weight: 100,
  active: true, backup: false, sessions_current: 0, sessions_max: 0,
  sessions_total: 0, queue_current: 0, bytes_in: 0, bytes_out: 0,
  connection_errors: 0, response_errors: 0, check_status: "L7OK",
  check_failures: 0, downtime_seconds: 0, last_change_seconds: 0,
  is_up: status === "UP",
} as ServerStat);

const NODE: NodeSnapshot = snapshot({
  node_id: 7,
  node_name: "lb-edge-1",
  frontends: [{
    name: "http-in", status: "OPEN", sessions_current: 2, sessions_max: 0,
    sessions_limit: 0, sessions_total: 0, bytes_in: 0, bytes_out: 0,
    request_errors: 0, requests_denied: 0, rate: 0, default_backend: "app-back",
    rule_backends: [], routed_backends: ["app-back"],
  }] as never,
  backends: [{
    name: "app-back", status: "UP", sessions_current: 0, sessions_max: 0,
    sessions_total: 0, queue_current: 0, bytes_in: 0, bytes_out: 0,
    connection_errors: 0, response_errors: 0,
    servers: [server("web1", "UP"), server("web2", "UP"), server("web3", "DOWN")],
    servers_up: 2, servers_total: 3,
  }] as BackendStat[],
});

/** Records every mutating call so a test can assert exactly what was sent. */
function installApi(over: { adminState?: () => unknown } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });

    if (path === "/fleet") return ok({ nodes: [NODE], summary: null });
    if (path === "/metrics/status") return ok({ enabled: false });
    if (path.endsWith("/admin-state")) {
      const result = over.adminState?.();
      if (result instanceof Error) {
        return { ok: false, status: 502, json: async () => ({ detail: result.message }) };
      }
      return ok({});
    }
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function show() {
  return renderWithProviders(
    <Routes><Route path="/nodes/:nodeId" element={<NodeDetail />} /></Routes>,
    { route: "/nodes/7" },
  );
}

const adminCalls = (calls: { path: string; body: unknown }[]) =>
  calls.filter((c) => c.path.endsWith("/admin-state"));

describe("NodeDetail action flow", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "test-token");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks before draining, and sends nothing until confirmed", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);

    // The dialog names the action and the target before anything happens.
    expect(await screen.findByText(/Set web1 to drain\?/)).toBeInTheDocument();
    expect(adminCalls(calls)).toHaveLength(0);
  });

  it("sends the change only after the confirm button", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Set drain" }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(1));
    expect(adminCalls(calls)[0]).toMatchObject({
      path: "/nodes/7/backends/app-back/servers/web1/admin-state",
      body: { state: "drain" },
    });
  });

  it("sends nothing when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Maint/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(adminCalls(calls)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText(/Set web1 to maint\?/)).not.toBeInTheDocument());
  });

  it("applies ready immediately, because returning to rotation is restorative", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web3");

    // web3 is DOWN, so its Ready control is enabled.
    const row = screen.getByText("web3").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /^Ready/ }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(1));
    expect(adminCalls(calls)[0].body).toEqual({ state: "ready" });
    // No confirmation for the safe direction.
    expect(screen.queryByRole("button", { name: "Set ready" })).not.toBeInTheDocument();
  });

  it("disables Ready for a server already in rotation, and says why", async () => {
    installApi();
    show();
    await screen.findByText("web1");

    const row = screen.getByText("web1").closest("tr")!;
    const ready = within(row).getByRole("button", { name: /already in rotation/ });
    expect(ready).toBeDisabled();
  });

  it("surfaces a failure inside the dialog rather than closing it", async () => {
    const user = userEvent.setup();
    const calls = installApi({ adminState: () => new Error("node refused the change") });
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Set drain" }));

    expect(await screen.findByText(/node refused the change/)).toBeInTheDocument();
    // Still open, so the operator can retry or cancel deliberately.
    expect(screen.getByText(/Set web1 to drain\?/)).toBeInTheDocument();
    expect(adminCalls(calls)).toHaveLength(1);
  });

  it("confirms success with a notice naming what changed", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Set drain" }));

    expect(await screen.findByText(/app-back\/web1 set to drain/)).toBeInTheDocument();
  });

  it("targets the row's own server, not the first one on the page", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web2");

    const row = screen.getByText("web2").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /^Maint/ }));
    await user.click(await screen.findByRole("button", { name: "Set maint" }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(1));
    // A shared dialog for the whole page makes this worth pinning down.
    expect(adminCalls(calls)[0].path).toContain("/servers/web2/");
    expect(adminCalls(calls)[0].body).toEqual({ state: "maint" });
  });

  it("keeps a backend's servers visible when the filter matched its frontend", async () => {
    // The regression: filtering on a frontend name showed the service and its
    // backend header above an empty table, because every server was then
    // tested against that same text and dropped.
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.type(screen.getByPlaceholderText(/Filter frontends/), "http-in");

    expect(screen.getAllByText("app-back").length).toBeGreaterThan(0);
    expect(screen.getByText("web1")).toBeInTheDocument();
    expect(screen.getByText("web2")).toBeInTheDocument();
  });

  it("still narrows to one server when the filter names a server", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.type(screen.getByPlaceholderText(/Filter frontends/), "web1");

    expect(screen.getByText("web1")).toBeInTheDocument();
    expect(screen.queryByText("web2")).not.toBeInTheDocument();
  });

  it("offers a bulk action bar once servers are selected", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    expect(screen.queryByText(/servers selected/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Select app-back\/web1/ }));
    await user.click(screen.getByRole("checkbox", { name: /Select app-back\/web2/ }));

    expect(screen.getByText("2 servers selected")).toBeInTheDocument();
  });

  it("selects every visible server in a backend at once", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getByRole("checkbox", { name: /Select every server in app-back/ }));
    expect(screen.getByText("3 servers selected")).toBeInTheDocument();
  });

  it("warns before a selection would empty a backend", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getByRole("checkbox", { name: /Select every server in app-back/ }));
    await user.click(screen.getByRole("button", { name: "Drain" }));

    // One at a time this is obvious; twelve at once is not.
    expect(await screen.findByText(/takes every active server out of/)).toBeInTheDocument();
  });

  it("sends one request per selected server", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getByRole("checkbox", { name: /Select app-back\/web1/ }));
    await user.click(screen.getByRole("checkbox", { name: /Select app-back\/web2/ }));
    await user.click(screen.getByRole("button", { name: "Drain" }));
    await user.click(await screen.findByRole("button", { name: "Set drain" }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(2));
    // Per-server calls, so each keeps its own audit entry and RBAC check.
    expect(adminCalls(calls).map((c) => c.path.split("/servers/")[1].split("/")[0]).sort())
      .toEqual(["web1", "web2"]);
    expect(adminCalls(calls).every((c) => (c.body as { state: string }).state === "drain")).toBe(true);
  });

  it("sends nothing until the bulk change is confirmed", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getByRole("checkbox", { name: /Select app-back\/web1/ }));
    await user.click(screen.getByRole("button", { name: "Maint" }));

    expect(adminCalls(calls)).toHaveLength(0);
  });

  it("offers an auto-revert window when taking a server out", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);

    const picker = await screen.findByRole("combobox", { name: /Return to rotation after/ });
    expect(picker).toHaveValue("");  // open-ended by default
    expect(screen.getByText(/quietly halved/)).toBeInTheDocument();
  });

  it("does not offer a window for putting a server back", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web3");

    // "ready" applies immediately and has nothing to revert.
    const row = screen.getByText("web3").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /^Ready/ }));

    expect(screen.queryByRole("combobox", { name: /Return to rotation after/ }))
      .not.toBeInTheDocument();
  });

  it("sends no window unless one was chosen", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Set drain" }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(1));
    // A timed window is a promise; never make one the operator did not ask for.
    expect(adminCalls(calls)[0].body).toEqual({ state: "drain" });
  });

  it("sends the chosen window with the change", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Drain/ })[0]);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /Return to rotation after/ }), "30");
    await user.click(screen.getByRole("button", { name: "Set drain" }));

    await waitFor(() => expect(adminCalls(calls)).toHaveLength(1));
    expect(adminCalls(calls)[0].body).toEqual({ state: "drain", for_minutes: 30 });
  });

  it("no longer renders graphs - those moved to the Metrics page", async () => {
    // Guards the split: the node page answers "what is it doing now", and
    // re-adding a metrics panel here would quietly restore the duplication.
    const calls = installApi();
    show();
    await screen.findByText("web1");

    expect(screen.queryByText("Metrics")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/metrics"))).toBe(false);
  });

  it("warns that maint drops sessions immediately before confirming", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    await screen.findByText("web1");

    await user.click(screen.getAllByRole("button", { name: /^Maint/ })[0]);

    // The dialog must state the consequence, not just the action.
    const dialog = await screen.findByText(/Set web1 to maint\?/);
    expect(dialog.closest("dialog")).toHaveTextContent(/app-back/);
  });
});
