import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Audit from "./Audit";
import { renderWithProviders } from "../test/render";
import { installEventSource } from "../test/sse";

const ENTRIES = [
  { id: 3, at: "2026-08-21T10:00:00Z", username: "alice", action: "set_admin_state",
    node_name: "lb-edge-1", target: "app-back/web2", detail: "drain", success: true,
    source_ip: "10.0.0.5" },
  { id: 2, at: "2026-08-21T09:00:00Z", username: "bob", action: "delete_node",
    node_name: "lb-old", target: null, detail: null, success: false, source_ip: "10.0.0.6" },
];

function installApi(status = 200, body: unknown = ENTRIES) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status === 200, status,
    json: async () => (status === 200 ? body : { detail: "Forbidden" }),
  })));
}

describe("Audit log", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "t");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows who did what, to which node", async () => {
    installApi();
    renderWithProviders(<Audit />, { route: "/audit" });

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("set_admin_state")).toBeInTheDocument();
    expect(screen.getByText("lb-edge-1")).toBeInTheDocument();
    expect(screen.getByText("app-back/web2")).toBeInTheDocument();
  });

  it("filters across every column, not just the user", async () => {
    const user = userEvent.setup();
    installApi();
    renderWithProviders(<Audit />, { route: "/audit" });
    await screen.findByText("alice");

    await user.type(screen.getByPlaceholderText(/Filter by user/), "app-back");
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
  });

  it("can narrow to failed actions", async () => {
    const user = userEvent.setup();
    installApi();
    renderWithProviders(<Audit />, { route: "/audit" });
    await screen.findByText("alice");

    await user.click(screen.getByRole("button", { name: "Failures only" }));
    // The failed delete stays; the successful drain goes.
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
  });

  it("explains a 403 rather than showing a raw error", async () => {
    installApi(403);
    renderWithProviders(<Audit />, { route: "/audit" });

    await waitFor(() =>
      expect(screen.getByText(/administrators only/)).toBeInTheDocument());
  });
});
