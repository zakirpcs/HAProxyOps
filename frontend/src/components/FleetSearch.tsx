import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { StatusDot } from "./ui";
import type { SearchHit } from "../types";

/**
 * Fleet-wide name search, in the app shell.
 *
 * "Which node serves this backend?" is otherwise answered by opening nodes one
 * at a time, which stops working somewhere around the tenth node. The server
 * searches every snapshot it holds, so this covers frontends, backends,
 * servers and server addresses across the whole fleet in one call.
 */
export default function FleetSearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // "/" focuses search, the convention everywhere else this pattern appears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || el instanceof HTMLSelectElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Debounced: a search per keystroke would scan every snapshot on the server
  // for text the operator has not finished typing.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      setCount(0);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      api.search(term)
        .then((r) => {
          if (cancelled) return;
          setHits(r.results.slice(0, 12));
          setCount(r.count);
          setOpen(true);
        })
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setBusy(false));
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQuery("");
    navigate(`/nodes/${hit.node_id}`);
  };

  return (
    <div ref={box} className="relative hidden md:block">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder="Search the fleet…  /"
        aria-label="Search frontends, backends and servers across the fleet"
        className="w-56 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs text-slate-200 outline-none transition focus:border-[var(--color-accent)] focus:w-72"
      />

      {open && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute right-0 z-40 mt-1 max-h-96 w-96 overflow-auto rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
        >
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-xs text-[var(--color-mute)]">
              {busy ? "Searching…" : `Nothing matches “${query.trim()}”.`}
            </p>
          ) : (
            <>
              {hits.map((hit) => (
                <button
                  key={`${hit.node_id}-${hit.kind}-${hit.backend ?? ""}-${hit.name}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => go(hit)}
                  className="flex w-full items-center gap-2 border-b border-ink-800 px-3 py-2 text-left last:border-b-0 hover:bg-ink-800"
                >
                  <StatusDot status={hit.status} size={6} />
                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
                    {hit.kind}
                  </span>
                  <span className="truncate font-mono text-xs text-slate-200">{hit.name}</span>
                  {hit.backend && (
                    <span className="truncate font-mono text-[10px] text-[var(--color-mute)]">
                      in {hit.backend}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 truncate text-[11px] text-[var(--color-mute)]">
                    {hit.node_name}
                  </span>
                </button>
              ))}
              {count > hits.length && (
                // Say what is not shown rather than silently truncating.
                <p className="px-3 py-2 text-[11px] text-[var(--color-mute)]">
                  {count - hits.length} more match. Narrow the search to see them.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
