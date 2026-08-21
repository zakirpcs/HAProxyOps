import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Nodes from "./Nodes";
import { renderWithProviders } from "../test/render";
import { installEventSource } from "../test/sse";

const NODE = {
  id: 1, name: "lb-edge-1", group: "edge", driver: "dataplane",
  base_url: "http://lb1:5555", api_prefix: "/v3", username: "u",
  has_password: true, verify_tls: false, enabled: true,
  prometheus_instance: "lb1:8404", stats_path: null,
};

function installApi() {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    if (init.body) sent.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/nodes") return ok(init.method === "POST" ? NODE : [NODE]);
    return ok({});
  }));
  return sent;
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
  renderWithProviders(<Nodes />, { route: "/nodes" });
  await user.click(await screen.findByRole("button", { name: /Edit node/ }));
  return screen.getByRole("dialog");
};

describe("Node modal tabs", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "t");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("offers Identity and Credentials plus Connection", async () => {
    const user = userEvent.setup();
    installApi();
    const dialog = await openEditor(user);

    expect(within(dialog).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["Identity and Credentials", "Connection"]);
    expect(within(dialog).getByRole("tab", { name: "Identity and Credentials" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("shows exactly one panel at a time", async () => {
    const user = userEvent.setup();
    installApi();
    const dialog = await openEditor(user);
    const panels = ["identity", "connection"];
    const shown = () => panels.filter(
      (id) => !document.getElementById(`node-panel-${id}`)?.hasAttribute("hidden"));

    expect(shown()).toEqual(["identity"]);
    await user.click(within(dialog).getByRole("tab", { name: "Connection" }));
    expect(shown()).toEqual(["connection"]);
    await user.click(within(dialog).getByRole("tab", { name: "Identity and Credentials" }));
    expect(shown()).toEqual(["identity"]);
  });

  it("keeps the metrics target with the connection settings", async () => {
    const user = userEvent.setup();
    installApi();
    const dialog = await openEditor(user);

    await user.click(within(dialog).getByRole("tab", { name: "Connection" }));
    const panel = document.getElementById("node-panel-connection")!;
    // Merged deliberately: the scrape target is another address for the node.
    expect(within(panel).getByText(/Prometheus instance/)).toBeInTheDocument();
    expect(within(panel).getByText(/Base URL/)).toBeInTheDocument();
  });

  it("keeps the credentials with identity on one tab", async () => {
    installApi();
    renderWithProviders(<Nodes />, { route: "/nodes" });
    await screen.findByRole("button", { name: /Edit node/ });

    const panel = document.getElementById("node-panel-identity")!;
    // Merged deliberately; both sections keep their own headings inside it.
    expect(within(panel).getByText("Identity")).toBeInTheDocument();
    expect(within(panel).getByText("Credentials")).toBeInTheDocument();
    expect(within(panel).getByText(/Password/)).toBeInTheDocument();
  });

  it("keeps edits made on a tab that is no longer showing", async () => {
    // The panels stay mounted; switching tabs must not discard a field.
    const user = userEvent.setup();
    const sent = installApi();
    const dialog = await openEditor(user);

    const nameField = within(dialog).getByDisplayValue("lb-edge-1");
    await user.clear(nameField);
    await user.type(nameField, "renamed-lb");

    await user.click(within(dialog).getByRole("tab", { name: "Connection" }));
    const promField = within(dialog).getByDisplayValue("lb1:8404");
    await user.clear(promField);
    await user.type(promField, "other:9100");

    await user.click(within(dialog).getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toMatchObject({
      body: { name: "renamed-lb", prometheus_instance: "other:9100" },
    });
  });
});
