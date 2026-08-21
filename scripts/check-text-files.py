#!/usr/bin/env python3
"""Fail if a source file stops being plain text.

A stray NUL byte in a source file is close to invisible: it compiles, it runs,
and the tests pass, because a NUL round-trips through a join/split as reliably
as a space. What it breaks is the tooling around the file - `grep`, `file`, and
anything else line-oriented treat it as binary and skip it **silently**. A
search that quietly misses a file is worse than one that errors.

This checks the bytes rather than asking `file`, whose heuristics report short
or unusual files as binary when they are fine.

    scripts/check-text-files.py            # whole repo
    scripts/check-text-files.py frontend   # a subtree

Exits non-zero on the first problem so CI stops.
"""
from __future__ import annotations

import pathlib
import sys

#: Directories that legitimately hold binaries or vendored code.
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "dist", "build",
    "__pycache__", ".vite", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "coverage", ".next",
}

#: Extensions whose files are expected to be binary.
BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg.gz", ".webp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z",
    ".db", ".sqlite", ".sqlite3", ".pyc", ".so", ".dylib", ".dll", ".wasm",
    ".mp4", ".webm", ".mp3", ".wav",
}

#: Control bytes that have no business in source. Tab, LF and CR are fine;
#: everything else below 0x20, plus DEL, is not.
FORBIDDEN = (set(range(0, 9)) | {11, 12} | set(range(14, 32)) | {127})

NAMES = {0: "NUL", 7: "BEL", 8: "BS", 11: "VT", 12: "FF", 27: "ESC", 127: "DEL"}


def context(raw: bytes, index: int, width: int = 40) -> str:
    chunk = raw[max(0, index - width): index + width]
    return chunk.decode("utf-8", "replace").replace("\n", "\\n").replace("\x00", "␀")


def check(root: pathlib.Path) -> list[str]:
    problems: list[str] = []
    scanned = 0

    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue

        raw = path.read_bytes()
        scanned += 1

        hits = [(i, b) for i, b in enumerate(raw) if b in FORBIDDEN]
        if hits:
            index, byte = hits[0]
            name = NAMES.get(byte, f"0x{byte:02x}")
            problems.append(
                f"{path}: {len(hits)} control byte(s); first is {name} at offset {index}\n"
                f"    …{context(raw, index)}…"
            )
            continue

        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            problems.append(f"{path}: not valid UTF-8 ({exc.reason} at byte {exc.start})")

    print(f"checked {scanned} files under {root}")
    return problems


def main() -> int:
    roots = [pathlib.Path(a) for a in sys.argv[1:]] or [pathlib.Path(".")]
    problems: list[str] = []
    for root in roots:
        if not root.exists():
            print(f"no such path: {root}", file=sys.stderr)
            return 2
        problems.extend(check(root))

    if problems:
        print("\nThese files are not plain text, so grep and file will skip them:\n",
              file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "\nA NUL is usually a mistyped separator - a join/split argument that "
            "should have been a space.",
            file=sys.stderr,
        )
        return 1

    print("all files are plain UTF-8 text")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
