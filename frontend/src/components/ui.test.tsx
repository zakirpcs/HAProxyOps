import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IconButton, RoleLabel, humanBytes, humanDuration } from "./ui";
import type { IconName } from "./Icon";

const ICONS: IconName[] = ["edit", "test", "play", "pause", "trash", "drain", "wrench"];

describe("IconButton", () => {
  it.each(ICONS)("gives the %s icon an accessible name", (icon) => {
    // An icon has no text of its own; without the label the button is unnamed.
    render(<IconButton icon={icon} label={`Do ${icon}`} onClick={() => {}} />);
    const button = screen.getByRole("button", { name: `Do ${icon}` });
    expect(button).toHaveAttribute("title", `Do ${icon}`);
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("does not fire while disabled", async () => {
    const onClick = vi.fn();
    render(<IconButton icon="trash" label="Remove" onClick={onClick} disabled />);
    screen.getByRole("button", { name: "Remove" }).click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("RoleLabel", () => {
  it("captions a section", () => {
    render(<RoleLabel>Frontend</RoleLabel>);
    expect(screen.getByText("Frontend")).toBeInTheDocument();
  });
});

describe("formatters", () => {
  it.each([
    [0, "0 B"],
    // Bytes are whole; every larger unit keeps one decimal, so 3 MB is "3.0 MB".
    [1536, "1.5 KB"],
    [1024 * 1024 * 3, "3.0 MB"],
    [1024 ** 5 * 2, "2.0 PB"],
  ])("humanBytes(%i) = %s", (n, expected) => {
    expect(humanBytes(n as number)).toBe(expected);
  });

  it.each([
    [null, "-"],
    [-1, "-"],
    [45, "45s"],
    [90, "1m 30s"],
    [3660, "1h 1m"],
    [90000, "1d 1h"],
  ])("humanDuration(%s) = %s", (seconds, expected) => {
    // null and negative both mean "unknown", not zero.
    expect(humanDuration(seconds as number | null)).toBe(expected);
  });
});
