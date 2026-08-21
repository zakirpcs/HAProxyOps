import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NavItem, UserChip } from "./App";
import type { Role } from "./types";

describe("NavItem", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("marks the active tab for assistive tech, not just visually", () => {
    render(
      <MemoryRouter>
        <NavItem to="/" label="Fleet" active />
        <NavItem to="/metrics" label="Metrics" active={false} />
        <NavItem to="/nodes" label="Nodes" active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Metrics" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Nodes" })).not.toHaveAttribute("aria-current");
  });
});

describe("UserChip", () => {
  it.each<[Role]>([["admin"], ["operator"], ["viewer"]])(
    "renders the %s role", (role) => {
      const { container } = render(<UserChip username="zakir" role={role} />);
      expect(screen.getByText(role)).toBeInTheDocument();
      expect(screen.getByText("zakir")).toBeInTheDocument();
      // The avatar is decorative; the name carries the meaning.
      expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("z");
    },
  );

  it("keeps the full identity reachable when the text is hidden on small screens", () => {
    render(<UserChip username="zakir" role="admin" />);
    expect(screen.getByTitle("zakir (admin)")).toBeInTheDocument();
  });
});
