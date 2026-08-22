import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfigEditor from "./ConfigEditor";
import { renderWithProviders } from "../test/render";
import { installEventSource } from "../test/sse";

const CONFIG = "global\n\nfrontend f\n    bind *:80\n";

function installApi(over: {
  valid?: boolean; message?: string; applyStatus?: number; rawStatus?: number;
} = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });

    if (path.endsWith("/config/raw") && (init.method ?? "GET") === "GET") {
      if (over.rawStatus && over.rawStatus !== 200) {
        return { ok: false, status: over.rawStatus, json: async () => ({ detail: "nope" }) };
      }
      return ok({ node: "lb-1", config: CONFIG, version: "7" });
    }
    if (path.endsWith("/config/validate")) {
      return ok({
        valid: over.valid ?? true,
        message: over.message ?? "HAProxy accepted this configuration.",
      });
    }
    if (path.endsWith("/config/raw")) {
      if (over.applyStatus && over.applyStatus !== 200) {
        return { ok: false, status: over.applyStatus,
                 json: async () => ({ detail: "version mismatch" }) };
      }
      return ok({ ok: true, node: "lb-1", lines: 4 });
    }
    return ok({});
  }));
  return calls;
}
const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });

const show = () =>
  renderWithProviders(<ConfigEditor nodeId={1} nodeName="lb-1" />, { route: "/config" });

type Call = { method: string; path: string; body?: Record<string, unknown> };
const applyCalls = (c: Call[]) =>
  c.filter((x) => x.method === "PUT" && x.path.endsWith("/config/raw"));

describe("ConfigEditor", () => {
  beforeEach(() => {
    installEventSource();
    localStorage.setItem("haproxyops.token", "t");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the node's configuration and its version", async () => {
    installApi();
    show();
    expect(await screen.findByDisplayValue(/frontend f/)).toBeInTheDocument();
    expect(screen.getByText(/Version/)).toBeInTheDocument();
  });

  it("cannot apply until the config has been validated", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    const box = await screen.findByRole("textbox");

    await user.type(box, "\n# a change");
    // Validation is the gate that makes the operator read the result.
    expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeEnabled());
  });

  it("cannot apply an unchanged config", async () => {
    installApi();
    show();
    await screen.findByRole("textbox");
    expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeDisabled();
  });

  it("shows HAProxy's own message when a config is rejected", async () => {
    const user = userEvent.setup();
    installApi({ valid: false, message: "unable to find required default_backend: 'x'" });
    show();
    const box = await screen.findByRole("textbox");

    await user.type(box, "\n# bad");
    await user.click(screen.getByRole("button", { name: "Validate" }));

    expect(await screen.findByText(/unable to find required default_backend/))
      .toBeInTheDocument();
    // And it must stay un-appliable.
    expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeDisabled();
  });

  it("re-arms validation after any further edit", async () => {
    const user = userEvent.setup();
    installApi();
    show();
    const box = await screen.findByRole("textbox");

    await user.type(box, "\n# one");
    await user.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeEnabled());

    await user.type(box, "\n# two");
    // The earlier result was for different text; applying on it would be a lie.
    expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeDisabled();
  });

  it("gives the dialog button a distinct name from the toolbar one", async () => {
    // Two buttons reading "Apply and reload" on screen at once is ambiguous to
    // anyone not looking at the pointer.
    const user = userEvent.setup();
    installApi();
    show();
    const box = await screen.findByRole("textbox");
    await user.type(box, "\n# c");
    await user.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply and reload/ }));

    expect(await screen.findByRole("button", { name: "Apply to lb-1" })).toBeInTheDocument();
  });

  it("asks before applying, and sends nothing until confirmed", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    const box = await screen.findByRole("textbox");

    await user.type(box, "\n# change");
    await user.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply and reload/ }));

    expect(await screen.findByText(/Apply this configuration to lb-1/)).toBeInTheDocument();
    expect(applyCalls(calls)).toHaveLength(0);
  });

  it("sends the edited config with the version it was read at", async () => {
    const user = userEvent.setup();
    const calls = installApi();
    show();
    const box = await screen.findByRole("textbox");

    await user.type(box, "\n# change");
    await user.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply and reload/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply and reload/ }));
    await user.click(await screen.findByRole("button", { name: "Apply to lb-1" }));

    await waitFor(() => expect(applyCalls(calls)).toHaveLength(1));
    // The version is what stops a stale edit clobbering a concurrent one.
    expect(applyCalls(calls)[0].body).toMatchObject({ version: "7" });
    expect(String(applyCalls(calls)[0].body?.config)).toContain("# change");
  });

  it("explains a transport that cannot serve configuration", async () => {
    installApi({ rawStatus: 501 });
    show();
    expect(await screen.findByText(/cannot read or write configuration/))
      .toBeInTheDocument();
  });
});
