import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import FleetSearch from "./FleetSearch";

const HITS = [
  { node_id: 3, node_name: "lb-internal-1", kind: "backend", name: "api-back", status: "UP" },
  { node_id: 1, node_name: "lb-edge-1", kind: "server", name: "web1", backend: "app-back", status: "UP" },
];

function installApi() {
  const queries: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    queries.push(new URL(String(url), "http://x").searchParams.get("q") ?? "");
    return { ok: true, status: 200, json: async () =>
      ({ query: "q", count: 2, results: HITS }) };
  }));
  return queries;
}

const show = () => render(<MemoryRouter><FleetSearch /></MemoryRouter>);

describe("Fleet search", () => {
  beforeEach(() => localStorage.setItem("haproxyops.token", "t"));
  afterEach(() => vi.unstubAllGlobals());

  it("finds things on nodes you are not looking at", async () => {
    const user = userEvent.setup();
    installApi();
    show();

    await user.type(screen.getByRole("textbox"), "api-back");

    expect(await screen.findByText("api-back")).toBeInTheDocument();
    // The node is the answer to "which node serves this?".
    expect(screen.getByText("lb-internal-1")).toBeInTheDocument();
    expect(screen.getByText("in app-back")).toBeInTheDocument();
  });

  it("does not search on every keystroke", async () => {
    const user = userEvent.setup();
    const queries = installApi();
    show();

    await user.type(screen.getByRole("textbox"), "api-back");
    await waitFor(() => expect(queries.length).toBeGreaterThan(0));
    // Debounced: one search for the finished word, not one per character.
    expect(queries.length).toBeLessThan(3);
  });

  it("ignores a single character, which would match most of the fleet", async () => {
    const user = userEvent.setup();
    const queries = installApi();
    show();

    await user.type(screen.getByRole("textbox"), "a");
    await new Promise((r) => setTimeout(r, 400));
    expect(queries).toHaveLength(0);
  });

  it("says how many matches it is not showing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        query: "web", count: 40,
        results: Array.from({ length: 40 }, (_, i) => ({
          node_id: 1, node_name: "n", kind: "server", name: `web${i}`, status: "UP",
        })),
      }),
    })));
    show();

    await user.type(screen.getByRole("textbox"), "web");
    // Silently truncating would make the result list quietly wrong.
    expect(await screen.findByText(/28 more match/)).toBeInTheDocument();
  });
});
