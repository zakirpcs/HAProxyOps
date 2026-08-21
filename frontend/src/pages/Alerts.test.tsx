import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import Alerts from "./Alerts";
import { renderWithProviders } from "../test/render";
import { installEventSource } from "../test/sse";

const alert = (over = {}) => ({
  key: "backend-down:1:app", severity: "critical", title: "lb-1/app has no active servers",
  detail: "All 2 active servers are down.", node: "lb-1",
  labels: { node_id: 1, backend: "app", kind: "backend_down" },
  since: Date.now() / 1000 - 300, for_seconds: 300, state: "firing", ...over,
});

function installApi(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ delivery_configured: true, for_seconds: 60, count: 0, alerts: [], ...body }),
  })));
}

describe("Alerts page", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "t");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("says plainly when nothing is wrong", async () => {
    installApi({ alerts: [], count: 0 });
    renderWithProviders(<Alerts />, { route: "/alerts" });
    expect(await screen.findByText(/Nothing is firing/)).toBeInTheDocument();
  });

  it("shows a firing alert with its detail and how long it has lasted", async () => {
    installApi({ alerts: [alert()], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });

    expect(await screen.findByText(/has no active servers/)).toBeInTheDocument();
    expect(screen.getByText(/All 2 active servers are down/)).toBeInTheDocument();
    // Duration has its own column; 300s renders as "5m 0s".
    expect(screen.getByText("5m 0s")).toBeInTheDocument();
    expect(screen.getByText("sent")).toBeInTheDocument();
  });

  it("distinguishes a pending alert from one that was sent", async () => {
    // Live but not yet announced - showing it as "sent" would be a lie.
    installApi({ alerts: [alert({ state: "pending", for_seconds: 12 })], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });

    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.queryByText("sent")).not.toBeInTheDocument();
    expect(screen.getByText(/must last 60s before it is/)).toBeInTheDocument();
  });

  it("warns when nothing is actually being delivered", async () => {
    // Silence must not be mistaken for health.
    installApi({ delivery_configured: false, alerts: [alert()], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });
    expect(await screen.findByText(/No webhook configured/)).toBeInTheDocument();
  });

  it("does not warn about delivery once a webhook is set", async () => {
    installApi({ delivery_configured: true, alerts: [alert()], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });
    await screen.findByText(/has no active servers/);
    expect(screen.queryByText(/No webhook configured/)).not.toBeInTheDocument();
  });

  it("links to the node the alert is about", async () => {
    installApi({ alerts: [alert()], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });
    // The node column is the link; a separate "open" line would cost a row.
    expect(await screen.findByRole("link", { name: "lb-1" }))
      .toHaveAttribute("href", "/nodes/1");
  });

  it("does not repeat the node name inside the alert text", async () => {
    // The node has its own column, so "lb-1/app has no active servers" would
    // print lb-1 twice on one line.
    installApi({ alerts: [alert()], count: 1 });
    renderWithProviders(<Alerts />, { route: "/alerts" });
    expect(await screen.findByText("app has no active servers")).toBeInTheDocument();
  });

  it("puts critical alerts above warnings", async () => {
    installApi({ count: 2, alerts: [
      alert(),
      alert({ key: "d", severity: "warning", title: "lb-2/api is degraded", node: "lb-2" }),
    ]});
    renderWithProviders(<Alerts />, { route: "/alerts" });
    await screen.findByText(/has no active servers/);
    const text = document.body.textContent ?? "";
    expect(text.indexOf("no active servers")).toBeLessThan(text.indexOf("is degraded"));
  });
});
